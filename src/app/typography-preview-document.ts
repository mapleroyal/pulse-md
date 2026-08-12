export const TYPOGRAPHY_PREVIEW_MARKDOWN = `# An Evening at North Ridge

The best observing nights begin slowly. Arrive before dusk, let your eyes adjust, and keep the plan close enough to consult without interrupting the view.

## Before the light fades

Set the tripod on firm ground and point the red lamp away from the trail. Tonight's notes live in \`north-ridge.md\`, alongside the weather log.

### Prepare the station

Give every tool a home before working in the dark.

#### West platform

The western rail blocks the valley wind and leaves a clear line toward Cygnus.

##### Camera check

Take one short frame before committing to the sequence.

###### Exposure note

Keep the first pass conservative; the sky will darken for another hour.

\`\`\`ts
const usable = frames.filter((frame) => frame.signal >= 0.8)
usable.forEach((frame) => archive(frame))
\`\`\`

> [!Tip] Preserve the quiet
> Record the result, then step away from the screen for a minute before deciding what to change.
`
