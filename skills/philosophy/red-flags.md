# Design Red Flags

These are warning signs of complexity, drawn from *A Philosophy of Software Design* and *Clean Code*. A red flag is a prompt to look closer, not proof of a problem. Each one includes the usual fix.

## Module and interface

| Red flag | How to spot it | Usual fix |
| --- | --- | --- |
| **Shallow module** | The interface is about as complex as the implementation | Merge it into its caller or callee, or move more work behind the interface |
| **Information leakage** | Two modules both encode the same decision, such as a format or an ordering | Give that decision to one module and have the other call it |
| **Temporal decomposition** | Modules are named after steps (`Reader`, `Parser`, `Writer`) and share knowledge | Regroup the code by the knowledge each part needs |
| **Overexposure** | Callers must learn rarely used options to do the common thing | Make the common case need no options, and move the rare options to a separate entry point |
| **Pass-through method** | A method only forwards its arguments to another method with the same signature | Remove the layer, or give it a real responsibility |
| **Pass-through variable** | A value is threaded through many signatures only to reach a deep callee | Put it in a shared context object, or let the deep module own it |
| **Special–general mixture** | A general-purpose module contains checks for one caller's special case | Move the special case up into that caller |
| **Conjoined methods** | You cannot understand one method without reading another one | Merge them, or redraw the boundary so each stands alone |
| **Configuration explosion** | Many knobs, each pushing a decision onto callers | Choose good defaults internally and expose only what callers truly vary |
| **Exception surface** | Callers wrap every call in `try` for errors they cannot handle | Define the error out of existence, or handle it inside the module |

## Code and naming

| Red flag | How to spot it | Usual fix |
| --- | --- | --- |
| **Vague name** | `data`, `info`, `manager`, `handle`, `tmp`, `result2` | Name the specific thing it holds or does |
| **Hard to pick a name** | No short name fits | The thing does too much or too little, so redraw its boundary |
| **Inconsistent names** | The same concept is called `user`, `account` and `member` | Use one word per concept everywhere |
| **Flag argument** | `render(true)` | Split it into two functions with clear names |
| **Hidden side effect** | A query function also mutates state | Separate the command from the query |
| **Mixed abstraction levels** | Business rules sit next to byte manipulation in one body | Extract the lower level into a named operation |
| **Train wreck** | `a.getB().getC().getD()` | Ask the direct collaborator to do the work (Law of Demeter) |
| **Null returns** | Every caller checks for `null` | Return an empty collection or an optional type, or throw |
| **Repetition** | The same non-trivial logic appears in several places | Give the rule a single owner (see `reusing-code`) |
| **Non-obvious code** | A reader cannot tell what it does, or why, without tracing it | Improve the names and structure first. If that is not enough, add a comment |

## Comments

| Red flag | How to spot it | Usual fix |
| --- | --- | --- |
| **Comment repeats code** | `// increment i` | Delete it |
| **Implementation details in an interface comment** | The doc comment explains internal steps | Describe only what callers see. Move how-it-works notes inside the body |
| **Hard to describe** | The interface comment needs many caveats | The abstraction is wrong, so fix the design first |
| **Stale comment** | The comment contradicts the code | Update it in the same change, or delete it |
| **Commented-out code** | Dead code is kept "just in case" | Delete it, since version control keeps the history |

## Process

| Red flag | How to spot it | Usual fix |
| --- | --- | --- |
| **"Just this once" hack** | A special case added to ship faster | Spend the extra time to fit it into the design |
| **One design considered** | The first idea was implemented without an alternative | Sketch a second, very different design and compare the two |
| **Change touches many unrelated files** | A single requirement causes widespread edits | Find the decision that is not owned by one module, and centralize it |
