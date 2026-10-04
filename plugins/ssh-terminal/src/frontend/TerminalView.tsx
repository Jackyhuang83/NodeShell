import { Suspense, lazy, type Ref } from "react";
import type { TerminalHandle } from "./terminal/terminal-types";

const Terminal = lazy(() =>
  import("./terminal/Terminal").then((m) => ({ default: m.Terminal })),
);

/** The SSH terminal as an embeddable plugin view. */
export function TerminalView({
  handleRef,
  ...props
}: {
  handleRef?: Ref<TerminalHandle>;
  [prop: string]: unknown;
}) {
  return (
    <Suspense fallback={null}>
      <Terminal
        ref={handleRef}
        {...(props as unknown as React.ComponentProps<typeof Terminal>)}
      />
    </Suspense>
  );
}
