import { describe, expect, it } from "bun:test";
import { allowDashboardMutation } from "../src/models-admin";

describe("models-admin CSRF", () => {
	it("rejects a foreign Origin", () => {
		expect(
			allowDashboardMutation(
				new Request("http://127.0.0.1:3847/api/models-admin/apply", {
					method: "POST",
					headers: { Origin: "https://evil.example" },
				}),
			),
		).toBe(false);
	});

	it("rejects Sec-Fetch-Site cross-site even without Origin", () => {
		expect(
			allowDashboardMutation(
				new Request("http://127.0.0.1:3847/api/models-admin/apply", {
					method: "POST",
					headers: { "Sec-Fetch-Site": "cross-site" },
				}),
			),
		).toBe(false);
	});

	it("allows a same-origin dashboard POST", () => {
		expect(
			allowDashboardMutation(
				new Request("http://127.0.0.1:3847/api/models-admin/apply", {
					method: "POST",
					headers: {
						Origin: "http://127.0.0.1:3847",
						"Sec-Fetch-Site": "same-origin",
					},
				}),
			),
		).toBe(true);
	});

	it("allows curl-style POSTs with no Origin", () => {
		expect(
			allowDashboardMutation(new Request("http://127.0.0.1:3847/api/models-admin/apply", { method: "POST" })),
		).toBe(true);
	});
});
