// @vitest-environment node
import { Window } from "happy-dom";
import { expect, it } from "vitest";

it("does not execute inline scripts written into a default Window", async () => {
  const window = new Window();
  try {
    window.document.write(
      "<script>window.__TDSF_TEST_INLINE_EXECUTED__=true</script>",
    );
    await window.happyDOM.waitUntilComplete();

    expect(
      (window as unknown as { __TDSF_TEST_INLINE_EXECUTED__?: boolean })
        .__TDSF_TEST_INLINE_EXECUTED__,
    ).toBeUndefined();
  } finally {
    await window.happyDOM.close();
  }
});

it("still parses and queries ordinary DOM in a default Window", async () => {
  const window = new Window();
  try {
    window.document.write("<main><p>safe fixture</p></main>");

    expect(window.document.querySelector("main p")?.textContent).toBe("safe fixture");
  } finally {
    await window.happyDOM.close();
  }
});
