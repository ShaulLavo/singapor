import { SEMANTIC_TOKEN_Z_INDEX } from '@singapor/core/extensions'
import { FIND_HIGHLIGHT_Z_INDEX } from '@singapor/find'
import { describe, expect, it } from 'vitest'

import { DIAGNOSTIC_STYLES } from '../src/plugin.styles'

/**
 * The one regression test for a cross-package agreement nothing else enforces.
 *
 * `Highlight.priority` is a single document-global namespace that four subsystems write into from
 * three packages, and priority only decides between highlights that declare the *same* property —
 * the CSS Custom Highlight API resolves per property. So the only real contest is for `color`, and
 * exactly four producers declare one:
 *
 * | producer                   | priority | why it sits there                                   |
 * | -------------------------- | -------- | --------------------------------------------------- |
 * | syntax token highlights    | 0        | the colour everything else refines                  |
 * | the semantic token layer   | 1        | refines the syntactic colour; must not hide an error |
 * | `DIAGNOSTIC_STYLES.error`  | 2        | a problem outranks a shade of meaning                |
 * | `FIND_CURRENT_STYLE`       | 5        | an answer to a question the user just asked          |
 *
 * Before this ordering was declared, the error style carried no `zIndex` at all and sat at 0
 * alongside every token highlight — so whether an error's red text survived over a syntax-coloured
 * identifier came down to which style key the document's shared registry had seen first, which is a
 * function of session history rather than of anything anyone chose.
 *
 * The assertions below read the real values from the three packages rather than restating them,
 * because a test that restated them would go on passing while the thing it guards drifted.
 */
describe('the highlight priority band', () => {
  const SYNTAX_TOKEN_Z_INDEX = 0

  it('orders all four producers that declare a colour', () => {
    expect(SYNTAX_TOKEN_Z_INDEX).toBeLessThan(SEMANTIC_TOKEN_Z_INDEX)
    expect(SEMANTIC_TOKEN_Z_INDEX).toBeLessThan(DIAGNOSTIC_STYLES.error.zIndex ?? 0)
    expect(DIAGNOSTIC_STYLES.error.zIndex ?? 0).toBeLessThan(FIND_HIGHLIGHT_Z_INDEX.current)
  })

  it('pins the numbers themselves, so a change has to be deliberate', () => {
    expect(SEMANTIC_TOKEN_Z_INDEX).toBe(1)
    expect(DIAGNOSTIC_STYLES.error.zIndex).toBe(2)
    expect(FIND_HIGHLIGHT_Z_INDEX.scope).toBe(3)
    expect(FIND_HIGHLIGHT_Z_INDEX.match).toBe(4)
    expect(FIND_HIGHLIGHT_Z_INDEX.current).toBe(5)
  })

  /**
   * `color` is not the only property two producers can both declare, and an earlier version of this
   * band forgot it: the error diagnostic carries a **background** and an underline as well as a
   * colour, and all three find styles carry a background. Giving the error the find match's number
   * would have left that contest to registration order — the exact condition the numbers exist to
   * remove, moved from one property to another.
   */
  it('leaves no two background producers sharing a number', () => {
    const backgrounds = [
      DIAGNOSTIC_STYLES.error.zIndex ?? 0,
      FIND_HIGHLIGHT_Z_INDEX.scope,
      FIND_HIGHLIGHT_Z_INDEX.match,
      FIND_HIGHLIGHT_Z_INDEX.current,
    ]

    expect(new Set(backgrounds).size).toBe(backgrounds.length)
  })

  /**
   * And the order among them is the one that shipped before the error was given a number at all,
   * when it sat at the implicit 0 and every find highlight outranked it. Renumbering find upwards
   * rather than moving the error down is what keeps that true.
   */
  it('keeps every find highlight above the error background', () => {
    const error = DIAGNOSTIC_STYLES.error.zIndex ?? 0
    expect(FIND_HIGHLIGHT_Z_INDEX.scope).toBeGreaterThan(error)
    expect(FIND_HIGHLIGHT_Z_INDEX.match).toBeGreaterThan(error)
    expect(FIND_HIGHLIGHT_Z_INDEX.current).toBeGreaterThan(error)
  })

  it('leaves the sub-error diagnostics at the default, since none declares a colour', () => {
    for (const severity of ['warning', 'information', 'hint'] as const) {
      expect(DIAGNOSTIC_STYLES[severity].color, severity).toBeUndefined()
      expect(DIAGNOSTIC_STYLES[severity].zIndex, severity).toBeUndefined()
    }
  })
})
