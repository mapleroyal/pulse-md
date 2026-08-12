import { syntaxPreviewColors } from "@/editor/syntax-themes/palettes"
import {
  resolveAppearanceProfile,
  type AppearanceProfile,
  type ResolvedAppearance,
} from "@/shared/contracts"

interface ThemePreviewProps {
  profile: AppearanceProfile
  scheme: ResolvedAppearance
}

export function ThemePreview({ profile, scheme }: ThemePreviewProps) {
  const appearance = resolveAppearanceProfile(profile)
  const syntax = syntaxPreviewColors(
    profile.syntaxThemeId,
    appearance.backgroundColor
  )
  const codeBackground = `color-mix(in oklab, ${appearance.surfaceTintColor} 8%, ${appearance.backgroundColor})`

  return (
    <section
      aria-label={`${scheme} theme preview`}
      className="col-span-full overflow-hidden rounded-3xl border border-border/70"
    >
      <div className="border-b border-border/70 px-4 py-2 text-xs font-medium text-muted-foreground">
        Preview · {scheme === "light" ? "Light profile" : "Dark profile"}
      </div>
      <div
        data-slot="theme-preview-surface"
        className="space-y-3 px-5 py-4"
        style={{
          backgroundColor: appearance.backgroundColor,
          color: appearance.foregroundColor,
        }}
      >
        <div>
          <div className="text-base font-semibold">Markdown, comfortably.</div>
          <p className="mt-1 text-sm opacity-80">
            Prose stays readable while code keeps its own visual rhythm.
          </p>
        </div>
        <pre
          className="overflow-x-auto rounded-xl px-4 py-3 font-mono text-xs leading-5"
          style={{ backgroundColor: codeBackground }}
        >
          <code>
            <span style={{ color: syntax.keyword }}>const</span>{" "}
            <span style={{ color: syntax.definition }}>theme</span>
            {" = "}
            <span style={{ color: syntax.string }}>&quot;focused&quot;</span>
            {";\n"}
            <span style={{ color: syntax.keyword }}>if</span>
            {" (theme.length > "}
            <span style={{ color: syntax.number }}>0</span>
            {") {\n  "}
            <span style={{ color: syntax.function }}>render</span>
            {"(theme);\n}\n"}
            <span style={{ color: syntax.comment }}>
              {"// Preview the selected syntax palette"}
            </span>
          </code>
        </pre>
      </div>
    </section>
  )
}
