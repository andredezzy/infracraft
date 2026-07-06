import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHintChannel, hint } from "../hint";

describe("hint", () => {
	let write: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		write = vi.fn().mockReturnValue(true);
		vi.spyOn(process.stderr, "write").mockImplementation(write);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("emits a delimited block of defaults plus project reminders when enabled", () => {
		hint({ enabled: true, project: ["Production is protected"] });

		expect(write).toHaveBeenCalledTimes(1);
		const out = write.mock.calls[0][0] as string;
		expect(out).toContain("<infracraft-hint>");
		expect(out).toContain("</infracraft-hint>");
		expect(out).toContain("Adopt-or-create"); // a baked-in default
		expect(out).toContain("- Production is protected"); // an appended project line
	});

	it("routes through pulumi.log when channel is PULUMI_LOG", () => {
		hint({ enabled: true, channel: AgentHintChannel.PULUMI_LOG });
		expect(write).not.toHaveBeenCalled();
	});

	it("is a no-op when explicitly disabled", () => {
		hint({ enabled: false, project: ["x"] });
		expect(write).not.toHaveBeenCalled();
	});

	it("auto-detects an agent via CLAUDECODE", () => {
		vi.stubEnv("CLAUDECODE", "1");
		hint();
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("is a no-op for humans (no agent env var)", () => {
		vi.stubEnv("CLAUDECODE", "");
		vi.stubEnv("AI_AGENT", "");
		hint();
		expect(write).not.toHaveBeenCalled();
	});
});
