#include <node_api.h>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <DispatcherQueue.h>
#include <d2d1effects.h>
#include <dwmapi.h>
#include <roapi.h>
#include <windows.foundation.h>
#include <windows.graphics.effects.h>
#include <windows.graphics.effects.interop.h>
#include <windows.ui.composition.interop.h>
#include <wrl.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Effects.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.Composition.Desktop.h>
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.h>
#include <winrt/base.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::WinRtClassicComMix;
namespace Composition = winrt::Windows::UI::Composition;
namespace CompositionDesktop = winrt::Windows::UI::Composition::Desktop;
namespace GraphicsEffects = winrt::Windows::Graphics::Effects;

constexpr float kBlurRadiusScale = 0.25f;
constexpr std::uint32_t kMaximumBlurRadius = 50;
constexpr double kMaximumAnimationTimeMs = 10000.0;
constexpr DWORD kDwmwaSystemBackdropType = 38;
constexpr int kDwmsbtNone = 1;

bool WindowOwnedByCurrentProcess(HWND window) noexcept;

void PrepareCustomBackdrop(HWND window) {
  const int backdrop = kDwmsbtNone;
  winrt::check_hresult(DwmSetWindowAttribute(
      window, kDwmwaSystemBackdropType, &backdrop, sizeof(backdrop)));
  DWM_BLURBEHIND blur_behind{};
  blur_behind.dwFlags = DWM_BB_ENABLE;
  blur_behind.fEnable = TRUE;
  winrt::check_hresult(DwmEnableBlurBehindWindow(window, &blur_behind));
}

void DisableCustomBackdrop(HWND window) noexcept {
  if (!WindowOwnedByCurrentProcess(window)) return;
  DWM_BLURBEHIND blur_behind{};
  blur_behind.dwFlags = DWM_BB_ENABLE;
  blur_behind.fEnable = FALSE;
  (void)DwmEnableBlurBehindWindow(window, &blur_behind);
}

bool WindowOwnedByCurrentProcess(HWND window) noexcept {
  DWORD process_id = 0;
  return IsWindow(window) &&
         GetWindowThreadProcessId(window, &process_id) != 0 &&
         process_id == GetCurrentProcessId();
}

class ScopedRoInitialization {
 public:
  ScopedRoInitialization() {
    const HRESULT result = RoInitialize(RO_INIT_SINGLETHREADED);
    if (FAILED(result) && result != RPC_E_CHANGED_MODE) {
      winrt::check_hresult(result);
    }
    initialized_ = SUCCEEDED(result);
  }

  ~ScopedRoInitialization() noexcept {
    if (initialized_) RoUninitialize();
  }

  ScopedRoInitialization(const ScopedRoInitialization&) = delete;
  ScopedRoInitialization& operator=(const ScopedRoInitialization&) = delete;

 private:
  bool initialized_ = false;
};

// Windows Composition accepts Direct2D effect descriptions through the
// IGraphicsEffectD2D1Interop contract. This deliberately implements only the
// Gaussian node Pulse needs instead of shipping Win2D or Windows App SDK.
class GaussianBlurEffect final
    : public RuntimeClass<
          RuntimeClassFlags<WinRtClassicComMix>,
          ABI::Windows::Graphics::Effects::IGraphicsEffect,
          ABI::Windows::Graphics::Effects::IGraphicsEffectSource,
          ABI::Windows::Graphics::Effects::IGraphicsEffectD2D1Interop> {
 public:
  InspectableClass(L"PulseMD.GaussianBlurEffect", BaseTrust);

 public:

  HRESULT SetName(const wchar_t* value) noexcept {
    return name_.Set(value);
  }

  void SetBlurAmount(float value) noexcept { blur_amount_ = value; }

  void SetSource(
      ABI::Windows::Graphics::Effects::IGraphicsEffectSource* value) noexcept {
    source_ = value;
  }

  IFACEMETHODIMP get_Name(HSTRING* value) override {
    return value == nullptr ? E_POINTER : name_.CopyTo(value);
  }

  IFACEMETHODIMP put_Name(HSTRING value) override { return name_.Set(value); }

  IFACEMETHODIMP GetEffectId(GUID* value) override {
    if (value == nullptr) return E_POINTER;
    *value = CLSID_D2D1GaussianBlur;
    return S_OK;
  }

  IFACEMETHODIMP GetNamedPropertyMapping(
      LPCWSTR name, UINT* index,
      ABI::Windows::Graphics::Effects::GRAPHICS_EFFECT_PROPERTY_MAPPING*
          mapping) override {
    if (name == nullptr || index == nullptr || mapping == nullptr) {
      return E_POINTER;
    }
    if (_wcsicmp(name, L"BlurAmount") == 0) {
      *index = D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION;
    } else if (_wcsicmp(name, L"Optimization") == 0) {
      *index = D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION;
    } else if (_wcsicmp(name, L"BorderMode") == 0) {
      *index = D2D1_GAUSSIANBLUR_PROP_BORDER_MODE;
    } else {
      return E_INVALIDARG;
    }
    *mapping = ABI::Windows::Graphics::Effects::
        GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT;
    return S_OK;
  }

  IFACEMETHODIMP GetPropertyCount(UINT* count) override {
    if (count == nullptr) return E_POINTER;
    *count = 3;
    return S_OK;
  }

  IFACEMETHODIMP GetProperty(
      UINT index, ABI::Windows::Foundation::IPropertyValue** value) override {
    if (value == nullptr) return E_POINTER;
    *value = nullptr;

    ComPtr<ABI::Windows::Foundation::IPropertyValueStatics> factory;
    Microsoft::WRL::Wrappers::HStringReference class_id(
        RuntimeClass_Windows_Foundation_PropertyValue);
    HRESULT result = RoGetActivationFactory(class_id.Get(), IID_PPV_ARGS(&factory));
    if (FAILED(result)) return result;

    IInspectable* property = nullptr;
    switch (index) {
      case D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION:
        result = factory->CreateSingle(blur_amount_, &property);
        break;
      case D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION:
        result = factory->CreateUInt32(D2D1_GAUSSIANBLUR_OPTIMIZATION_BALANCED,
                                       &property);
        break;
      case D2D1_GAUSSIANBLUR_PROP_BORDER_MODE:
        result = factory->CreateUInt32(D2D1_BORDER_MODE_HARD, &property);
        break;
      default:
        return E_INVALIDARG;
    }
    if (FAILED(result)) return result;
    *value = reinterpret_cast<ABI::Windows::Foundation::IPropertyValue*>(
        property);
    return S_OK;
  }

  IFACEMETHODIMP GetSource(
      UINT index,
      ABI::Windows::Graphics::Effects::IGraphicsEffectSource** value) override {
    if (value == nullptr) return E_POINTER;
    return index == 0 ? source_.CopyTo(value) : E_INVALIDARG;
  }

  IFACEMETHODIMP GetSourceCount(UINT* count) override {
    if (count == nullptr) return E_POINTER;
    *count = 1;
    return S_OK;
  }

 private:
  float blur_amount_ = 0.0f;
  Microsoft::WRL::Wrappers::HString name_;
  ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> source_;
};

GraphicsEffects::IGraphicsEffect ProjectEffect(
    const ComPtr<GaussianBlurEffect>& effect) {
  void* effect_abi = nullptr;
  winrt::check_hresult(effect.CopyTo(
      __uuidof(ABI::Windows::Graphics::Effects::IGraphicsEffect),
      &effect_abi));
  return GraphicsEffects::IGraphicsEffect(effect_abi,
                                          winrt::take_ownership_from_abi);
}

struct WindowEffect {
  Composition::CompositionBackdropBrush backdrop{nullptr};
  Composition::CompositionEffectBrush blur_brush{nullptr};
  Composition::SpriteVisual blur_visual{nullptr};
  Composition::ContainerVisual root{nullptr};
  CompositionDesktop::DesktopWindowTarget target{nullptr};
  Composition::CompositionColorBrush tint_brush{nullptr};
  Composition::SpriteVisual tint_visual{nullptr};
  std::uint32_t owner_id = 0;
};

class CompositionContext {
 public:
  CompositionContext() : thread_id_(GetCurrentThreadId()) {
    if (winrt::Windows::System::DispatcherQueue::GetForCurrentThread() ==
        nullptr) {
      DispatcherQueueOptions options{
          sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT,
          DQTAT_COM_NONE};
      winrt::check_hresult(CreateDispatcherQueueController(
          options,
          reinterpret_cast<ABI::Windows::System::IDispatcherQueueController**>(
              winrt::put_abi(dispatcher_queue_controller_))));
    }

    compositor_ = Composition::Compositor();

    auto source_parameter =
        Composition::CompositionEffectSourceParameter(L"source");
    auto source = source_parameter.as<GraphicsEffects::IGraphicsEffectSource>();
    const auto effect = Microsoft::WRL::Make<GaussianBlurEffect>();
    if (!effect) winrt::throw_hresult(E_OUTOFMEMORY);
    winrt::check_hresult(effect->SetName(L"Blur"));
    effect->SetBlurAmount(0.0f);
    effect->SetSource(reinterpret_cast<
                      ABI::Windows::Graphics::Effects::IGraphicsEffectSource*>(
        winrt::get_abi(source)));
    const std::vector<winrt::hstring> animated_properties{
        L"Blur.BlurAmount"};
    blur_factory_ = compositor_.CreateEffectFactory(
        ProjectEffect(effect), animated_properties);
    ValidateBlurFactory();
  }

  ~CompositionContext() {
    for (auto& [window, effect] : windows_) {
      try {
        effect.target.Root(nullptr);
      } catch (...) {
        // Environment cleanup may follow HWND teardown. Releasing the target
        // object below remains sufficient even when its Root setter rejects.
      }
      DisableCustomBackdrop(window);
    }
    windows_.clear();
    blur_factory_ = nullptr;
    compositor_ = nullptr;
    dispatcher_queue_controller_ = nullptr;
  }

  bool OnOwningThread() const noexcept {
    return GetCurrentThreadId() == thread_id_;
  }

  bool Set(HWND window, std::uint32_t owner_id, std::uint32_t radius,
           std::uint8_t red, std::uint8_t green, std::uint8_t blue,
           double opacity) {
    if (!WindowOwnedByCurrentProcess(window) || !OnOwningThread()) return false;
    ValidateBlurFactory();
    // Electron's temporary Acrylic material makes Aura's backing surface
    // alpha-capable. Override only DWM's visual material before attaching our
    // own backdrop; Electron retains the translucency plumbing until teardown.
    WindowEffect& effect = PrepareWindow(window, owner_id);
    effect.blur_brush.StopAnimation(L"Blur.BlurAmount");
    const float blur_amount = static_cast<float>(radius) * kBlurRadiusScale;
    effect.blur_brush.Properties().InsertScalar(L"Blur.BlurAmount",
                                                blur_amount);
    effect.blur_visual.Brush(radius == 0
                                 ? effect.backdrop
                                 : effect.blur_brush.as<Composition::CompositionBrush>());
    effect.tint_brush.Color(winrt::Windows::UI::Color{
        static_cast<std::uint8_t>(std::lround(opacity * 255.0)), red, green,
        blue});
    return true;
  }

  bool Animate(HWND window, std::uint32_t owner_id, std::uint32_t radius,
               double duration_ms, double delay_ms,
               const std::array<float, 4>& control_points) {
    if (!WindowOwnedByCurrentProcess(window) || !OnOwningThread()) return false;
    ValidateBlurFactory();
    WindowEffect& effect = PrepareWindow(window, owner_id);
    if (radius == 0 || duration_ms <= 0) {
      effect.blur_brush.StopAnimation(L"Blur.BlurAmount");
      effect.blur_brush.Properties().InsertScalar(L"Blur.BlurAmount", 0.0f);
      effect.blur_visual.Brush(effect.backdrop);
      return true;
    }

    effect.blur_visual.Brush(
        effect.blur_brush.as<Composition::CompositionBrush>());
    effect.blur_brush.Properties().InsertScalar(
        L"Blur.BlurAmount", static_cast<float>(radius) * kBlurRadiusScale);
    const auto animation = compositor_.CreateScalarKeyFrameAnimation();
    animation.Duration(std::chrono::milliseconds(
        static_cast<std::int64_t>(std::lround(duration_ms))));
    animation.DelayTime(std::chrono::milliseconds(
        static_cast<std::int64_t>(std::lround(delay_ms))));
    animation.DelayBehavior(Composition::AnimationDelayBehavior::SetInitialValueBeforeDelay);
    animation.InsertKeyFrame(0.0f, 0.0f);
    animation.InsertKeyFrame(
        1.0f, static_cast<float>(radius) * kBlurRadiusScale,
        compositor_.CreateCubicBezierEasingFunction(
            {control_points[0], control_points[1]},
            {control_points[2], control_points[3]}));
    effect.blur_brush.StartAnimation(L"Blur.BlurAmount", animation);
    return true;
  }

  bool Clear(HWND window, std::uint32_t owner_id) {
    if (!OnOwningThread()) return false;
    const auto existing = windows_.find(window);
    if (existing == windows_.end()) return true;
    // BrowserWindow IDs distinguish successive Electron windows even if the
    // kernel has already recycled an HWND before a delayed `closed` callback.
    if (existing->second.owner_id != owner_id) return true;
    try {
      existing->second.target.Root(nullptr);
    } catch (...) {
      // The HWND can already be gone when Electron emits `closed`. Releasing
      // the retained target is still required and is sufficient at that point.
    }
    windows_.erase(existing);
    DisableCustomBackdrop(window);
    return true;
  }

 private:
  WindowEffect& PrepareWindow(HWND window, std::uint32_t owner_id) {
    const auto existing = windows_.find(window);
    if (existing != windows_.end() && existing->second.owner_id == owner_id) {
      return existing->second;
    }
    PrepareCustomBackdrop(window);
    try {
      return EnsureWindow(window, owner_id);
    } catch (...) {
      DisableCustomBackdrop(window);
      throw;
    }
  }

  void ValidateBlurFactory() const {
    const auto load_status = blur_factory_.LoadStatus();
    // Windows compiles effect graphs asynchronously. Pending factories already
    // accept brushes and begin rendering when compilation completes.
    if (load_status == Composition::CompositionEffectFactoryLoadStatus::Success ||
        load_status == Composition::CompositionEffectFactoryLoadStatus::Pending) {
      return;
    }
    const HRESULT error = blur_factory_.ExtendedError();
    winrt::throw_hresult(FAILED(error) ? error : E_FAIL);
  }

  WindowEffect& EnsureWindow(HWND window, std::uint32_t owner_id) {
    const auto existing = windows_.find(window);
    if (existing != windows_.end()) {
      if (existing->second.owner_id == owner_id) return existing->second;
      existing->second.target.Root(nullptr);
      windows_.erase(existing);
    }

    WindowEffect effect;
    effect.owner_id = owner_id;
    auto desktop_interop =
        compositor_.as<ABI::Windows::UI::Composition::Desktop::
                           ICompositorDesktopInterop>();
    winrt::check_hresult(desktop_interop->CreateDesktopWindowTarget(
        window, FALSE,
        reinterpret_cast<ABI::Windows::UI::Composition::Desktop::
                             IDesktopWindowTarget**>(
            winrt::put_abi(effect.target))));

    effect.root = compositor_.CreateContainerVisual();
    effect.root.RelativeSizeAdjustment({1.0f, 1.0f});

    // DwmEnableBlurBehindWindow no longer adds a system blur on Windows 8 and
    // later, but it does make the HWND's alpha surface participate in desktop
    // composition. The bottom-most Backdrop brush can therefore sample the raw
    // pixels behind Pulse and leave all blur strength to our Gaussian effect.
    effect.backdrop = compositor_.CreateBackdropBrush();
    effect.blur_brush = blur_factory_.CreateBrush();
    effect.blur_brush.SetSourceParameter(L"source", effect.backdrop);
    effect.blur_visual = compositor_.CreateSpriteVisual();
    effect.blur_visual.RelativeSizeAdjustment({1.0f, 1.0f});
    effect.blur_visual.Brush(effect.backdrop);
    effect.root.Children().InsertAtBottom(effect.blur_visual);

    effect.tint_brush = compositor_.CreateColorBrush(
        winrt::Windows::UI::Color{0, 0, 0, 0});
    effect.tint_visual = compositor_.CreateSpriteVisual();
    effect.tint_visual.RelativeSizeAdjustment({1.0f, 1.0f});
    effect.tint_visual.Brush(effect.tint_brush);
    effect.root.Children().InsertAtTop(effect.tint_visual);

    effect.target.Root(effect.root);
    return windows_.emplace(window, std::move(effect)).first->second;
  }

  ScopedRoInitialization ro_initialization_;
  Composition::CompositionEffectFactory blur_factory_{nullptr};
  Composition::Compositor compositor_{nullptr};
  winrt::Windows::System::DispatcherQueueController
      dispatcher_queue_controller_{nullptr};
  DWORD thread_id_ = 0;
  std::unordered_map<HWND, WindowEffect> windows_;
};

std::unique_ptr<CompositionContext> context;

napi_value Boolean(napi_env environment, bool value) {
  napi_value result = nullptr;
  if (napi_get_boolean(environment, value, &result) != napi_ok) return nullptr;
  return result;
}

napi_value ThrowNativeError(napi_env environment,
                            const char* fallback_message) noexcept {
  try {
    throw;
  } catch (const winrt::hresult_error& error) {
    const std::string message = winrt::to_string(error.message());
    napi_throw_error(environment, nullptr,
                     message.empty() ? fallback_message : message.c_str());
  } catch (const std::exception& error) {
    napi_throw_error(environment, nullptr, error.what());
  } catch (...) {
    napi_throw_error(environment, nullptr, fallback_message);
  }
  return nullptr;
}

HWND WindowHandle(napi_env environment, napi_value value) {
  bool is_buffer = false;
  if (napi_is_buffer(environment, value, &is_buffer) != napi_ok || !is_buffer) {
    napi_throw_type_error(environment, nullptr,
                          "The native window handle must be a Buffer");
    return nullptr;
  }
  void* bytes = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(environment, value, &bytes, &length) != napi_ok ||
      length < sizeof(HWND)) {
    napi_throw_type_error(environment, nullptr,
                          "The native window handle is invalid");
    return nullptr;
  }
  HWND window = nullptr;
  std::memcpy(&window, bytes, sizeof(window));
  if (window == nullptr) {
    napi_throw_type_error(environment, nullptr,
                          "The native window handle is null");
  }
  return window;
}

CompositionContext* Context() {
  if (!context) context = std::make_unique<CompositionContext>();
  return context.get();
}

napi_value SetWindowBackgroundEffect(napi_env environment,
                                     napi_callback_info info) {
  size_t argument_count = 7;
  napi_value arguments[7] = {};
  if (napi_get_cb_info(environment, info, &argument_count, arguments, nullptr,
                       nullptr) != napi_ok) {
    return nullptr;
  }
  if (argument_count != 7) {
    napi_throw_type_error(
        environment, nullptr,
        "setWindowBackgroundEffect requires a native handle, owner ID, "
        "radius, RGB channels, and opacity");
    return nullptr;
  }

  const HWND window = WindowHandle(environment, arguments[0]);
  if (window == nullptr) return nullptr;
  std::uint32_t owner_id = 0;
  std::uint32_t radius = 0;
  std::uint32_t red = 0;
  std::uint32_t green = 0;
  std::uint32_t blue = 0;
  double opacity = 0;
  if (napi_get_value_uint32(environment, arguments[1], &owner_id) != napi_ok ||
      napi_get_value_uint32(environment, arguments[2], &radius) != napi_ok ||
      napi_get_value_uint32(environment, arguments[3], &red) != napi_ok ||
      napi_get_value_uint32(environment, arguments[4], &green) != napi_ok ||
      napi_get_value_uint32(environment, arguments[5], &blue) != napi_ok ||
      napi_get_value_double(environment, arguments[6], &opacity) != napi_ok) {
    napi_throw_type_error(environment, nullptr,
                          "The background effect values must be numeric");
    return nullptr;
  }
  if (owner_id == 0 || radius > kMaximumBlurRadius || red > 255 ||
      green > 255 || blue > 255 || !std::isfinite(opacity) || opacity < 0 ||
      opacity > 1) {
    napi_throw_range_error(environment, nullptr,
                           "The background effect values are outside range");
    return nullptr;
  }

  try {
    return Boolean(environment,
                   Context()->Set(window, owner_id, radius,
                                  static_cast<std::uint8_t>(red),
                                  static_cast<std::uint8_t>(green),
                                  static_cast<std::uint8_t>(blue), opacity));
  } catch (...) {
    return ThrowNativeError(environment,
                            "Unable to set the Windows background effect");
  }
}

napi_value AnimateWindowBackgroundBlur(napi_env environment,
                                       napi_callback_info info) {
  size_t argument_count = 9;
  napi_value arguments[9] = {};
  if (napi_get_cb_info(environment, info, &argument_count, arguments, nullptr,
                       nullptr) != napi_ok) {
    return nullptr;
  }
  if (argument_count != 9) {
    napi_throw_type_error(
        environment, nullptr,
        "animateWindowBackgroundBlur requires a native handle, owner ID, "
        "radius, duration, delay, and four timing-function control points");
    return nullptr;
  }

  const HWND window = WindowHandle(environment, arguments[0]);
  if (window == nullptr) return nullptr;
  std::uint32_t owner_id = 0;
  std::uint32_t radius = 0;
  double duration_ms = 0;
  double delay_ms = 0;
  std::array<double, 4> raw_control_points{};
  if (napi_get_value_uint32(environment, arguments[1], &owner_id) != napi_ok ||
      napi_get_value_uint32(environment, arguments[2], &radius) != napi_ok ||
      napi_get_value_double(environment, arguments[3], &duration_ms) !=
          napi_ok ||
      napi_get_value_double(environment, arguments[4], &delay_ms) != napi_ok) {
    napi_throw_type_error(environment, nullptr,
                          "The blur animation values must be numeric");
    return nullptr;
  }
  for (size_t index = 0; index < raw_control_points.size(); ++index) {
    if (napi_get_value_double(environment, arguments[index + 5],
                              &raw_control_points[index]) != napi_ok) {
      napi_throw_type_error(environment, nullptr,
                            "The timing-function values must be numeric");
      return nullptr;
    }
  }
  if (owner_id == 0 || radius > kMaximumBlurRadius ||
      !std::isfinite(duration_ms) ||
      duration_ms < 0 || duration_ms > kMaximumAnimationTimeMs ||
      !std::isfinite(delay_ms) || delay_ms < 0 ||
      delay_ms > kMaximumAnimationTimeMs ||
      std::any_of(raw_control_points.begin(), raw_control_points.end(),
                  [](double value) { return !std::isfinite(value); }) ||
      raw_control_points[0] < 0 || raw_control_points[0] > 1 ||
      raw_control_points[2] < 0 || raw_control_points[2] > 1) {
    napi_throw_range_error(environment, nullptr,
                           "The blur animation values are outside range");
    return nullptr;
  }

  const std::array<float, 4> control_points{
      static_cast<float>(raw_control_points[0]),
      static_cast<float>(raw_control_points[1]),
      static_cast<float>(raw_control_points[2]),
      static_cast<float>(raw_control_points[3]),
  };
  try {
    return Boolean(environment,
                   Context()->Animate(window, owner_id, radius, duration_ms,
                                      delay_ms, control_points));
  } catch (...) {
    return ThrowNativeError(environment,
                            "Unable to animate the Windows background blur");
  }
}

napi_value ClearWindowBackgroundEffect(napi_env environment,
                                       napi_callback_info info) {
  size_t argument_count = 2;
  napi_value arguments[2] = {};
  if (napi_get_cb_info(environment, info, &argument_count, arguments, nullptr,
                       nullptr) != napi_ok) {
    return nullptr;
  }
  if (argument_count != 2) {
    napi_throw_type_error(
        environment, nullptr,
        "clearWindowBackgroundEffect requires a native handle and owner ID");
    return nullptr;
  }
  const HWND window = WindowHandle(environment, arguments[0]);
  if (window == nullptr) return nullptr;
  std::uint32_t owner_id = 0;
  if (napi_get_value_uint32(environment, arguments[1], &owner_id) != napi_ok) {
    napi_throw_type_error(environment, nullptr,
                          "The background effect owner ID must be numeric");
    return nullptr;
  }
  if (owner_id == 0) {
    napi_throw_range_error(environment, nullptr,
                           "The background effect owner ID is outside range");
    return nullptr;
  }
  try {
    return Boolean(environment, !context || context->Clear(window, owner_id));
  } catch (...) {
    return ThrowNativeError(environment,
                            "Unable to clear the Windows background effect");
  }
}

void Cleanup(void*) { context.reset(); }

napi_value Initialize(napi_env environment, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"setWindowBackgroundEffect", nullptr, SetWindowBackgroundEffect,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"animateWindowBackgroundBlur", nullptr, AnimateWindowBackgroundBlur,
       nullptr, nullptr, nullptr, napi_default, nullptr},
      {"clearWindowBackgroundEffect", nullptr, ClearWindowBackgroundEffect,
       nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(environment, exports, std::size(properties),
                             properties) != napi_ok ||
      napi_add_env_cleanup_hook(environment, Cleanup, nullptr) != napi_ok) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
