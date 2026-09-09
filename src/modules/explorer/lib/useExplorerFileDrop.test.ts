import { describe, expect, it } from "vitest";
import { remoteUploadTargets } from "./useExplorerFileDrop";

describe("remoteUploadTargets", () => {
  it("keeps each local basename and targets the selected remote directory", () => {
    expect(
      remoteUploadTargets(
        [
          "C:\\Users\\Administrator\\Desktop\\report.txt",
          "/tmp/archive.tar.gz",
        ],
        "/root/uploads",
      ),
    ).toEqual([
      {
        localPath: "C:\\Users\\Administrator\\Desktop\\report.txt",
        remotePath: "/root/uploads/report.txt",
      },
      {
        localPath: "/tmp/archive.tar.gz",
        remotePath: "/root/uploads/archive.tar.gz",
      },
    ]);
  });

  it("handles the remote root without a double slash", () => {
    expect(remoteUploadTargets(["C:\\tmp\\app.conf"], "/")).toEqual([
      { localPath: "C:\\tmp\\app.conf", remotePath: "/app.conf" },
    ]);
  });
});
