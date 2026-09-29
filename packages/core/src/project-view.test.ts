import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createProjectView } from "./project-view.js";

describe("createProjectView", () => {
  const { project, maps } = loadFixtureProject("minimal");
  const view = createProjectView(project, maps);

  it("looks entities up by id", () => {
    expect(view.project).toBe(project);
    expect(view.map("map_start" as never)?.width).toBe(10);
    expect(view.tileset("ts_basic" as never)?.name).toBe("基本");
    expect(view.actor("actor_hero" as never)?.name).toBe("勇者");
    expect(view.class("class_hero" as never)?.name).toBe("戦士");
  });

  it("returns undefined for unknown ids and for the other tables' ids", () => {
    expect(view.map("nope" as never)).toBeUndefined();
    expect(view.skill("x" as never)).toBeUndefined();
    expect(view.item("x" as never)).toBeUndefined();
    expect(view.enemy("x" as never)).toBeUndefined();
    expect(view.troop("x" as never)).toBeUndefined();
    expect(view.commonEvent("x" as never)).toBeUndefined();
    expect(view.actor("class_hero" as never)).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("does not resolve prototype property %s", (id) => {
    for (const lookup of [view.map, view.tileset, view.actor, view.class, view.skill, view.item, view.enemy, view.troop, view.commonEvent]) {
      expect(lookup(id as never)).toBeUndefined();
    }
  });

  it("reflects maps that are loaded later (lazy loading)", () => {
    const lazyMaps: typeof maps = {};
    const lazy = createProjectView(project, lazyMaps);
    expect(lazy.map("map_start" as never)).toBeUndefined();
    lazyMaps["map_start" as never] = maps["map_start" as never]!;
    expect(lazy.map("map_start" as never)).toBeDefined();
  });

  it("works without any maps", () => {
    expect(createProjectView(project).map("map_start" as never)).toBeUndefined();
  });
});
