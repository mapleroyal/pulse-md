#include <node_api.h>

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <dlfcn.h>

#include <cstdint>
#include <cstring>
#include <cmath>

namespace {

constexpr CGFloat kWindowCornerRadius = 10.0;
char kBackdropContainerKey;
char kBackdropLayerKey;
char kBackgroundTintLayerKey;
char kBackdropResizeObserverKey;
NSString* const kBackdropRadiusAnimationKey =
    @"PulseMDBackdropRadius";

constexpr std::int32_t kCGSNeverFlattenSurfacesDuringSwipesTagBit = 1 << 16;
constexpr std::int32_t kCGSWindowTagBitCount = 0x40;

using CGSConnectionID = std::int32_t;
using CGSWindowID = std::int32_t;
using CGSMainConnectionIDFunction = CGSConnectionID (*)();
using CGSSetWindowTagsFunction = std::int32_t (*)(
    CGSConnectionID, CGSWindowID, const std::int32_t*, std::int32_t);

struct WindowServerFunctions {
  CGSMainConnectionIDFunction main_connection_id;
  CGSSetWindowTagsFunction set_window_tags;
};

const WindowServerFunctions& GetWindowServerFunctions() {
  static const WindowServerFunctions functions = [] {
    // Resolve the private SPI at runtime so a renamed or unavailable symbol
    // disables only the Spaces-specific protection, not the whole addon.
    void* handle =
        dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
               RTLD_LAZY | RTLD_LOCAL);
    if (handle == nullptr) return WindowServerFunctions{nullptr, nullptr};
    return WindowServerFunctions{
        reinterpret_cast<CGSMainConnectionIDFunction>(
            dlsym(handle, "CGSMainConnectionID")),
        reinterpret_cast<CGSSetWindowTagsFunction>(
            dlsym(handle, "CGSSetWindowTags")),
    };
  }();
  return functions;
}

bool ApplyNeverFlattenDuringSpaceChangesTag(NSWindow* window) {
  if (window == nil || window.windowNumber <= 0) return false;
  const WindowServerFunctions& functions = GetWindowServerFunctions();
  if (functions.main_connection_id == nullptr ||
      functions.set_window_tags == nullptr) {
    return false;
  }

  // Window tags are a 64-bit mask represented as two 32-bit words. This bit
  // keeps WindowServer from flattening custom backdrop surfaces for its Spaces
  // and Mission Control transforms. NSWindow clears it after live resize.
  const std::int32_t tags[2] = {
      0,
      kCGSNeverFlattenSurfacesDuringSwipesTagBit,
  };
  return functions.set_window_tags(functions.main_connection_id(),
                                   static_cast<CGSWindowID>(window.windowNumber),
                                   tags, kCGSWindowTagBitCount) == 0;
}

void ScheduleNeverFlattenDuringSpaceChangesTag(NSWindow* window) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (window.windowNumber > 0) {
      ApplyNeverFlattenDuringSpaceChangesTag(window);
    }
  });
}

}  // namespace

@interface PulseMDBackdropResizeObserver : NSObject

@property(nonatomic, weak) NSWindow* window;

- (instancetype)initWithWindow:(NSWindow*)window;
- (void)windowDidEndLiveResize:(NSNotification*)notification;

@end

@implementation PulseMDBackdropResizeObserver

- (instancetype)initWithWindow:(NSWindow*)window {
  self = [super init];
  if (self == nil) return nil;

  _window = window;
  [[NSNotificationCenter defaultCenter]
      addObserver:self
         selector:@selector(windowDidEndLiveResize:)
             name:NSWindowDidEndLiveResizeNotification
           object:window];
  // The initial BrowserWindow setup continues after the backdrop is installed.
  // Defer until AppKit has finished publishing that first hosted surface so it
  // cannot overwrite the tag in the same creation turn.
  ScheduleNeverFlattenDuringSpaceChangesTag(window);
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)windowDidEndLiveResize:(NSNotification*)notification {
  NSWindow* window = self.window;
  if (window == nil) return;
  // AppKit clears the no-flatten tag at the end of a live resize. Reapply on
  // the next main-loop turn, after AppKit's balanced resize teardown finishes.
  ScheduleNeverFlattenDuringSpaceChangesTag(window);
}

@end

namespace {

void EnsureBackdropResizeObserver(NSWindow* window, NSView* content_view) {
  PulseMDBackdropResizeObserver* observer =
      objc_getAssociatedObject(content_view, &kBackdropResizeObserverKey);
  if (observer != nil) return;
  observer = [[PulseMDBackdropResizeObserver alloc] initWithWindow:window];
  objc_setAssociatedObject(content_view, &kBackdropResizeObserverKey, observer,
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

struct BackgroundLayers {
  CALayer* backdrop;
  CALayer* tint;
};

BackgroundLayers EnsureBackgroundLayers(NSWindow* window) {
  NSView* content_view = window.contentView;
  CALayer* root_layer = content_view.layer;
  if (content_view == nil || root_layer == nil) return {nil, nil};

  CALayer* container =
      objc_getAssociatedObject(content_view, &kBackdropContainerKey);
  CALayer* backdrop =
      objc_getAssociatedObject(content_view, &kBackdropLayerKey);
  CALayer* tint =
      objc_getAssociatedObject(content_view, &kBackgroundTintLayerKey);
  if (container == nil || backdrop == nil) {
    Class backdrop_class = NSClassFromString(@"CABackdropLayer");
    Class filter_class = NSClassFromString(@"CAFilter");
    SEL filter_selector = NSSelectorFromString(@"filterWithType:");
    if (backdrop_class == Nil || filter_class == Nil ||
        ![filter_class respondsToSelector:filter_selector]) {
      return {nil, nil};
    }

    using FilterFactory = id (*)(id, SEL, id);
    id filter = reinterpret_cast<FilterFactory>(objc_msgSend)(
        filter_class, filter_selector, @"gaussianBlur");
    backdrop = [backdrop_class layer];
    if (filter == nil || backdrop == nil) return {nil, nil};

    [window setValue:@NO forKey:@"shouldAutoFlattenLayerTree"];
    [window setValue:@NO forKey:@"canHostLayersInWindowServer"];
    [window setValue:@YES forKey:@"canHostLayersInWindowServer"];

    [filter setValue:@YES forKey:@"inputNormalizeEdges"];
    [backdrop setValue:@YES forKey:@"windowServerAware"];
    [backdrop setValue:@YES forKey:@"allowsGroupBlending"];
    [backdrop setValue:@YES forKey:@"allowsGroupOpacity"];
    [backdrop setValue:@YES forKey:@"disablesOccludedBackdropBlurs"];
    [backdrop setValue:@YES forKey:@"ignoresOffscreenGroups"];
    [backdrop setValue:@NO forKey:@"allowsInPlaceFiltering"];
    [backdrop setValue:@1.0 forKey:@"scale"];
    [backdrop setValue:@0 forKey:@"bleedAmount"];
    backdrop.filters = @[ filter ];
    backdrop.frame = content_view.bounds;
    backdrop.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;

    container = [CALayer layer];
    container.name = @"PulseMDBackdrop";
    container.frame = content_view.bounds;
    container.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    container.cornerRadius = kWindowCornerRadius;
    container.masksToBounds = YES;
    [container addSublayer:backdrop];

    tint = [CALayer layer];
    tint.name = @"PulseMDBackgroundTint";
    tint.frame = content_view.bounds;
    tint.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    [container addSublayer:tint];
    [root_layer insertSublayer:container atIndex:0];

    objc_setAssociatedObject(content_view, &kBackdropContainerKey, container,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(content_view, &kBackdropLayerKey, backdrop,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(content_view, &kBackgroundTintLayerKey, tint,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  } else if (tint == nil) {
    tint = [CALayer layer];
    tint.name = @"PulseMDBackgroundTint";
    tint.frame = content_view.bounds;
    tint.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
    [container addSublayer:tint];
    objc_setAssociatedObject(content_view, &kBackgroundTintLayerKey, tint,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  if (container.superlayer != root_layer ||
      root_layer.sublayers.firstObject != container) {
    [root_layer insertSublayer:container atIndex:0];
  }
  container.cornerRadius =
      (window.styleMask & NSWindowStyleMaskFullScreen) != 0
          ? 0
          : kWindowCornerRadius;

  EnsureBackdropResizeObserver(window, content_view);

  return {backdrop, tint};
}

bool SetBackgroundEffect(NSWindow* window, std::uint32_t radius,
                         std::uint32_t red, std::uint32_t green,
                         std::uint32_t blue, double opacity) {
  CGColorSpaceRef color_space =
      CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (color_space == nullptr) return false;
  const CGFloat components[] = {
      static_cast<CGFloat>(red) / 255.0,
      static_cast<CGFloat>(green) / 255.0,
      static_cast<CGFloat>(blue) / 255.0,
      static_cast<CGFloat>(opacity),
  };
  CGColorRef tint_color = CGColorCreate(color_space, components);
  CGColorSpaceRelease(color_space);
  if (tint_color == nullptr) return false;

  // Layer insertion and both model values commit together while the hidden
  // launch surface is still opaque. The first exposed native frame therefore
  // cannot contain the backdrop without its tint sibling.
  bool applied = false;
  bool transaction_started = false;
  @try {
    [CATransaction begin];
    transaction_started = true;
    [CATransaction setDisableActions:YES];
    BackgroundLayers layers = EnsureBackgroundLayers(window);
    if (layers.backdrop != nil && layers.tint != nil) {
      [layers.backdrop removeAnimationForKey:kBackdropRadiusAnimationKey];

      // CABackdropLayer's Gaussian radius is visually about four times stronger
      // than the legacy WindowServer radius exposed by the app's setting.
      [layers.backdrop setValue:@(static_cast<double>(radius) * 0.25)
                     forKeyPath:@"filters.gaussianBlur.inputRadius"];
      layers.tint.backgroundColor = tint_color;
      applied = true;
    }
  } @finally {
    // Private layer/KVC failures propagate to the N-API boundary, but they
    // must never strand Core Animation's main-thread transaction or CGColor.
    CGColorRelease(tint_color);
    if (transaction_started) [CATransaction commit];
  }
  return applied;
}

bool AnimateBackdropRadius(NSWindow* window, std::uint32_t radius,
                           double duration_ms, double delay_ms,
                           const double control_points[4]) {
  CALayer* backdrop = EnsureBackgroundLayers(window).backdrop;
  if (backdrop == nil) return false;
  if (duration_ms <= 0) {
    bool transaction_started = false;
    @try {
      [CATransaction begin];
      transaction_started = true;
      [CATransaction setDisableActions:YES];
      [backdrop setValue:@(static_cast<double>(radius) * 0.25)
               forKeyPath:@"filters.gaussianBlur.inputRadius"];
    } @finally {
      if (transaction_started) [CATransaction commit];
    }
    return true;
  }

  const double final_radius = static_cast<double>(radius) * 0.25;
  [backdrop removeAnimationForKey:kBackdropRadiusAnimationKey];

  bool transaction_started = false;
  @try {
    [CATransaction begin];
    transaction_started = true;
    [CATransaction setDisableActions:YES];
    [backdrop setValue:@(final_radius)
             forKeyPath:@"filters.gaussianBlur.inputRadius"];
  } @finally {
    if (transaction_started) [CATransaction commit];
  }

  CABasicAnimation* animation =
      [CABasicAnimation animationWithKeyPath:
                            @"filters.gaussianBlur.inputRadius"];
  animation.fromValue = @0.0;
  animation.toValue = @(final_radius);
  animation.duration = duration_ms / 1000.0;
  animation.beginTime = CACurrentMediaTime() + delay_ms / 1000.0;
  animation.fillMode = kCAFillModeBackwards;
  animation.removedOnCompletion = YES;
  animation.timingFunction = [CAMediaTimingFunction
      functionWithControlPoints:static_cast<float>(control_points[0])
                               :static_cast<float>(control_points[1])
                               :static_cast<float>(control_points[2])
                               :static_cast<float>(control_points[3])];
  [backdrop addAnimation:animation forKey:kBackdropRadiusAnimationKey];
  return true;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result = nullptr;
  if (napi_get_boolean(env, value, &result) != napi_ok) return nullptr;
  return result;
}

napi_value TabDragEscapeKeyPressed(napi_env env, napi_callback_info info) {
  size_t argument_count = 0;
  if (napi_get_cb_info(env, info, &argument_count, nullptr, nullptr, nullptr) !=
      napi_ok) {
    return nullptr;
  }
  if (argument_count != 0) {
    napi_throw_type_error(env, nullptr,
                          "tabDragEscapeKeyPressed takes no arguments");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr,
                     "Tab drag key state must be read on the main thread");
    return nullptr;
  }
  // Key code 53 is Escape. Querying Core Graphics state continues to work
  // while AppKit is running Chromium's nested native dragging loop.
  return Boolean(env, CGEventSourceKeyState(
                          kCGEventSourceStateCombinedSessionState, 53));
}

napi_value SetWindowBackgroundEffect(napi_env env, napi_callback_info info) {
  size_t argument_count = 6;
  napi_value arguments[6] = {nullptr, nullptr, nullptr,
                             nullptr, nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argument_count, arguments, nullptr,
                       nullptr) != napi_ok) {
    return nullptr;
  }
  if (argument_count != 6) {
    napi_throw_type_error(
        env, nullptr,
        "setWindowBackgroundEffect requires a native handle, radius, RGB "
        "channels, and opacity");
    return nullptr;
  }

  bool is_buffer = false;
  if (napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(env, nullptr,
                          "The native window handle must be a Buffer");
    return nullptr;
  }

  void* handle_bytes = nullptr;
  size_t handle_length = 0;
  if (napi_get_buffer_info(env, arguments[0], &handle_bytes, &handle_length) !=
          napi_ok ||
      handle_length < sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "The native window handle is invalid");
    return nullptr;
  }

  std::uint32_t radius = 0;
  std::uint32_t red = 0;
  std::uint32_t green = 0;
  std::uint32_t blue = 0;
  double opacity = 0;
  if (napi_get_value_uint32(env, arguments[1], &radius) != napi_ok ||
      napi_get_value_uint32(env, arguments[2], &red) != napi_ok ||
      napi_get_value_uint32(env, arguments[3], &green) != napi_ok ||
      napi_get_value_uint32(env, arguments[4], &blue) != napi_ok ||
      napi_get_value_double(env, arguments[5], &opacity) != napi_ok) {
    napi_throw_type_error(env, nullptr,
                          "The background effect values must be numeric");
    return nullptr;
  }
  if (red > 255 || green > 255 || blue > 255 || !std::isfinite(opacity) ||
      opacity < 0 || opacity > 1) {
    napi_throw_range_error(env, nullptr,
                           "The background tint values are outside range");
    return nullptr;
  }

  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr,
                     "Window background blur must run on the main thread");
    return nullptr;
  }

  void* view_pointer = nullptr;
  std::memcpy(&view_pointer, handle_bytes, sizeof(view_pointer));
  if (view_pointer == nullptr) return Boolean(env, false);

  @autoreleasepool {
    @try {
      NSView* view = (__bridge NSView*)view_pointer;
      NSWindow* window = view.window;
      if (window == nil || window.windowNumber <= 0) {
        return Boolean(env, false);
      }

      return Boolean(
          env, SetBackgroundEffect(window, radius, red, green, blue, opacity));
    } @catch (NSException*) {
      return Boolean(env, false);
    }
  }
}

napi_value AnimateWindowBackgroundBlur(napi_env env,
                                        napi_callback_info info) {
  size_t argument_count = 8;
  napi_value arguments[8] = {nullptr, nullptr, nullptr, nullptr,
                             nullptr, nullptr, nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argument_count, arguments, nullptr,
                       nullptr) != napi_ok) {
    return nullptr;
  }
  if (argument_count != 8) {
    napi_throw_type_error(
        env, nullptr,
        "animateWindowBackgroundBlur requires a native handle, radius, "
        "duration, delay, and four timing-function control points");
    return nullptr;
  }

  bool is_buffer = false;
  if (napi_is_buffer(env, arguments[0], &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(env, nullptr,
                          "The native window handle must be a Buffer");
    return nullptr;
  }

  void* handle_bytes = nullptr;
  size_t handle_length = 0;
  if (napi_get_buffer_info(env, arguments[0], &handle_bytes, &handle_length) !=
          napi_ok ||
      handle_length < sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "The native window handle is invalid");
    return nullptr;
  }

  std::uint32_t radius = 0;
  double duration_ms = 0;
  double delay_ms = 0;
  double control_points[4] = {0, 0, 1, 1};
  if (napi_get_value_uint32(env, arguments[1], &radius) != napi_ok ||
      napi_get_value_double(env, arguments[2], &duration_ms) != napi_ok ||
      napi_get_value_double(env, arguments[3], &delay_ms) != napi_ok) {
    napi_throw_type_error(env, nullptr,
                          "The blur animation values must be numeric");
    return nullptr;
  }
  for (size_t index = 0; index < 4; index += 1) {
    if (napi_get_value_double(env, arguments[index + 4],
                              &control_points[index]) != napi_ok) {
      napi_throw_type_error(env, nullptr,
                            "The timing-function values must be numeric");
      return nullptr;
    }
  }
  if (!std::isfinite(duration_ms) || duration_ms < 0 ||
      !std::isfinite(delay_ms) || delay_ms < 0 ||
      control_points[0] < 0 || control_points[0] > 1 ||
      control_points[2] < 0 || control_points[2] > 1) {
    napi_throw_range_error(env, nullptr,
                           "The blur animation values are outside range");
    return nullptr;
  }
  for (double point : control_points) {
    if (!std::isfinite(point) || point < 0 || point > 1) {
      napi_throw_range_error(env, nullptr,
                             "The timing-function values are outside range");
      return nullptr;
    }
  }

  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr,
                     "Window background blur must run on the main thread");
    return nullptr;
  }

  void* view_pointer = nullptr;
  std::memcpy(&view_pointer, handle_bytes, sizeof(view_pointer));
  if (view_pointer == nullptr) return Boolean(env, false);

  @autoreleasepool {
    @try {
      NSView* view = (__bridge NSView*)view_pointer;
      NSWindow* window = view.window;
      if (window == nil || window.windowNumber <= 0) {
        return Boolean(env, false);
      }

      return Boolean(env, AnimateBackdropRadius(window, radius, duration_ms,
                                                 delay_ms, control_points));
    } @catch (NSException*) {
      return Boolean(env, false);
    }
  }
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {
          "setWindowBackgroundEffect",
          nullptr,
          SetWindowBackgroundEffect,
          nullptr,
          nullptr,
          nullptr,
          napi_default,
          nullptr,
      },
      {
          "animateWindowBackgroundBlur",
          nullptr,
          AnimateWindowBackgroundBlur,
          nullptr,
          nullptr,
          nullptr,
          napi_default,
          nullptr,
      },
      {
          "tabDragEscapeKeyPressed",
          nullptr,
          TabDragEscapeKeyPressed,
          nullptr,
          nullptr,
          nullptr,
          napi_default,
          nullptr,
      },
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(macos_window_blur, Initialize)
