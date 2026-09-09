import type { Command } from "commander";
import { z } from "zod";
import type { DoctorCheck, DoctorReport } from "../../services/doctor-service.js";
import { style } from "../../ui/style.js";
import type { CliContext } from "../context.js";
import { writeJson, writeLine } from "../helpers.js";
import { parseCliInput } from "../input.js";

const doctorInputSchema = z.object({ json: z.boolean().default(false) }).strict();
export type DoctorInput = z.output<typeof doctorInputSchema>;

export function registerDoctorCommand(program: Command, context: CliContext): void {
  program
    .command("doctor")
    .description("Diagnose the runtime, workspace, Git state, and project configuration")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: unknown) => {
      await runDoctor(parseCliInput(doctorInputSchema, options), context);
    });
}

export async function runDoctor(input: DoctorInput, context: CliContext): Promise<DoctorReport> {
  const report = await context.doctor.inspect();
  if (input.json) writeJson(context.output.stdout, report);
  else printDoctorReport(report, context.output.stdout);
  if (report.status === "fail") process.exitCode = 1;
  return report;
}

function printDoctorReport(report: DoctorReport, stream: NodeJS.WritableStream): void {
  writeLine(stream, style.heading("Ygg doctor"));
  for (const check of report.checks) {
    writeLine(stream, `${checkLabel(check)} ${check.id} — ${check.summary}`);
    if (check.suggestion) writeLine(stream, `  ${style.label("Suggestion:")} ${check.suggestion}`);
  }
  writeLine(stream, "");
  writeLine(stream, `${style.label("Overall:")} ${checkLabel({ status: report.status })}`);
}

function checkLabel(check: Pick<DoctorCheck, "status">): string {
  switch (check.status) {
    case "pass":
      return style.success("PASS");
    case "warning":
      return style.warning("WARN");
    case "fail":
      return style.danger("FAIL");
    case "skipped":
      return style.value("SKIP");
  }
}
