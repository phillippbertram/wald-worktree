import type { Command } from "commander";
import { z } from "zod";
import type { DoctorReport } from "../../services/doctor-service.js";
import { renderDoctorReport } from "../../ui/doctor.js";
import type { CliContext } from "../context.js";
import { writeJson, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const doctorInputSchema = z
  .object({ json: z.boolean().default(false), verbose: z.boolean().default(false) })
  .strict();
export type DoctorInput = z.output<typeof doctorInputSchema>;

export function registerDoctorCommand(program: Command, context: CliContext): void {
  program
    .command("doctor")
    .description("Diagnose the runtime, workspace, Git state, and project configuration")
    .option("--json", "Emit machine-readable JSON")
    .option("-v, --verbose", "Show every check and suggestion")
    .action(async (options: unknown) => {
      await runDoctor(parseCliInput(doctorInputSchema, options), context);
    });
}

export async function runDoctor(input: DoctorInput, context: CliContext): Promise<DoctorReport> {
  const report = await context.doctor.inspect();
  if (input.json) writeJson(context.output.stdout, report);
  else writeLine(context.output.stdout, renderDoctorReport(report, { verbose: input.verbose }));
  if (report.status === "fail") process.exitCode = 1;
  return report;
}
