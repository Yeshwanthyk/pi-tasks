import { describe, expect, it } from "vitest";
import { projectLabel, resolveProjectIdentity } from "../src/project-identity.js";

describe("project identity", () => {
  it("captures the current git workspace", () => {
    const project = resolveProjectIdentity();

    expect(project.name).toBe("pi-tasks");
    expect(project.root).toBe(process.cwd());
    expect(project.remote).toContain("pi-tasks");
    if (project.branch) expect(project.branch.length).toBeGreaterThan(0);
    expect(projectLabel(project)).toBe("pi-tasks");
  });

  it("labels legacy tasks without project metadata", () => {
    expect(projectLabel(undefined)).toBe("unknown");
  });
});
