import { describe, expect, it } from "bun:test";
import { getSafeTestDatabaseUrl } from "../helpers/postgres";

describe("test database safety guard", () => {
  const original = process.env.TEST_DATABASE_URL;

  it("accepts only local databases with a test suffix", () => {
    try {
      process.env.TEST_DATABASE_URL = "postgresql://wager:wager@localhost:55432/wagering_test";
      expect(getSafeTestDatabaseUrl()).toBe(process.env.TEST_DATABASE_URL);
      process.env.TEST_DATABASE_URL = "postgresql://wager:wager@localhost:5432/wagering";
      expect(() => getSafeTestDatabaseUrl()).toThrow("Refusing integration tests");
      process.env.TEST_DATABASE_URL = "postgresql://wager:wager@db.example/wagering_test";
      expect(() => getSafeTestDatabaseUrl()).toThrow("non-local PostgreSQL host");
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    }
  });
});
