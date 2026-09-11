import type { ReactNode } from 'react';

/** Test-only wrapper. Production App never imports this module. */
export function FixtureHarness({ children }: { children: ReactNode }) {
  return <div><div role="note">TEST FIXTURE — no live agents or payments</div>{children}</div>;
}
