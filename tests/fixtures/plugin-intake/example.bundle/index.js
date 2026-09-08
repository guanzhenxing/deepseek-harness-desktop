// Inert loader probe: the upstream cordis loader imports the bundle module
// when the profile boots. A broken or missing module fails the Host boot —
// a successful profile round IS the load proof. No side effects keeps the
// bundle digest deterministic.
export const name = '@fixture/m5-example-bundle'
export function apply() {}
