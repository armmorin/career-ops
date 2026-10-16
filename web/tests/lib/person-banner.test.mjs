import assert from "node:assert/strict";
import test from "node:test";
import { personBanner } from "../../src/lib/person-banner.mjs";

test("the banner names the person, root, and port", () => {
  const banner = personBanner({
    CAREER_OPS_PERSON: "Ada",
    CAREER_OPS_WEB_PORT: "3001",
  }, "/home/armando/career-people/Ada");
  assert.equal(banner.label, "Ada · /home/armando/career-people/Ada · port 3001");
});

test("an unset launch is Armando on port 3000", () => {
  const banner = personBanner({}, "/home/armando/career-ops");
  assert.equal(banner.name, "Armando");
  assert.equal(banner.port, "3000");
  assert.equal(banner.root, "/home/armando/career-ops");
  assert.equal(banner.label, "Armando · /home/armando/career-ops · port 3000");
});
