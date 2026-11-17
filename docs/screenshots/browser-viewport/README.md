# The Preview lays a web page out at a picked size: evidence

Evidence for ADR 0197: the row under the Preview's address picks Responsive, one of 17 devices, or a typed width and height, and the page lays out at that size.

## Where the screenshots come from

Every PNG here is a screenshot of the real Tauri app (WebKitGTK), run by the `verify-hermes-chat` skill in an isolated Xvfb against a stand-in Hermes. The page in the Preview is a local probe page that prints its own `innerWidth × innerHeight` and marks its corners and centre. No real Hermes server or user data is involved.

| File | State |
| --- | --- |
| `before-no-size-row.png` | Before (`main`): no size row. The page fills the Preview at 475 × 734. |
| `after-nest-hub-max.png` | After: Nest Hub Max picked. The page lays out at 1280 × 800, scaled to 36% to fit. |
| `after-typed-747x818.png` | After: 747 × 818 typed. The select reads Responsive, and the probe's typed text survived the size changes. |
| `after-invalid-width.png` | After: `12.5` typed as the width. The field is marked invalid and the page keeps 747 × 818. |
