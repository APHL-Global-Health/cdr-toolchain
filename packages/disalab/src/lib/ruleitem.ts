import * as Core from "./core.js";

export class RuleItem {
  Command: string | null | undefined;
  Unknown: string | null | undefined;
  Rule: string | null | undefined;
  Description?: string;

  constructor(
    command: string | null | undefined,
    unknown: string | null | undefined,
    rule: string | null | undefined,
  ) {
    this.Command = !Core.IsUndefinedOrNull(command) ? command.trim() : command;
    this.Unknown = !Core.IsUndefinedOrNull(unknown) ? unknown.trim() : unknown;
    this.Rule = !Core.IsUndefinedOrNull(rule) ? rule.trim() : rule;

    if (this.Command === "I") this.Description = "If";
    else if (this.Command === "N") this.Description = "IfNot";
    else if (this.Command === "A") this.Description = "And";
    else if (this.Command === "O") this.Description = "Or";
    else if (this.Command === "E") this.Description = "Else";
    else if (this.Command === "Z") this.Description = "Else NV";
    else if (this.Command === "C") this.Description = "Comment";
    else if (this.Command === "X") this.Description = "Exit";
  }
}
