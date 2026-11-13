import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AiInputBarConnect } from "./AiInputBar";

it("shows the Chinese provider and local-model hint and connects once", () => {
  const onAdd = vi.fn();
  render(<AiInputBarConnect onAdd={onAdd} />);

  expect(screen.getByText(/连接.*本地模型.*API/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "连接模型" }));
  expect(onAdd).toHaveBeenCalledTimes(1);
});
