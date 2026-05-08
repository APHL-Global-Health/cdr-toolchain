export const VERSION = "0.1.0";

export function describe(): string {
  return "disalab — DISA database query + transform library";
}

export type { DisaServer, DisaBytes } from "./lib/types.js";
export type { DisaInput } from "./lib/core.js";

export * as Core from "./lib/core.js";
export { BitConverter } from "./lib/bitconverter.js";
export { BaseValue } from "./lib/basevalue.js";
export { Order } from "./lib/order.js";
export { RuleItem } from "./lib/ruleitem.js";
export { Facility } from "./lib/facility.js";
export { OrderItem } from "./lib/orderitem.js";

export * as Logger from "./lib/logger.js";

export { COMMDICT } from "./lib/DisaGlobal/COMMDICT.js";
export { LOCNDIC4 } from "./lib/DisaGlobal/LOCNDIC4.js";
export { PARMDICT } from "./lib/DisaGlobal/PARMDICT.js";
export { SYSTDIC5 } from "./lib/DisaGlobal/SYSTDIC5.js";
export { TESTDICT } from "./lib/DisaGlobal/TESTDICT.js";

export { BREGDICT } from "./lib/DisalabDict/BREGDICT.js";
export { DESLDIC5 } from "./lib/DisalabDict/DESLDIC5.js";
export { DOCCDAT5 } from "./lib/DisalabDict/DOCCDAT5.js";
export { ORDRDIC5 } from "./lib/DisalabDict/ORDRDIC5.js";
export { RULEDIC5 } from "./lib/DisalabDict/RULEDIC5.js";
export { WRKADICT } from "./lib/DisalabDict/WRKADICT.js";

export { AUDTDATA } from "./lib/DisalabData/AUDTDATA.js";
export { HISDAT5 } from "./lib/DisalabData/HISDAT5.js";
export { LABNDAT4 } from "./lib/DisalabData/LABNDAT4.js";
export { LOCKDAT5 } from "./lib/DisalabData/LOCKDAT5.js";
export { ORDRDAT5 } from "./lib/DisalabData/ORDRDAT5.js";
export { PRINTQ4 } from "./lib/DisalabData/PRINTQ4.js";
export { RDNMIDX4 } from "./lib/DisalabData/RDNMIDX4.js";
export { RDOBIDX4 } from "./lib/DisalabData/RDOBIDX4.js";
export { RDOCIDX4 } from "./lib/DisalabData/RDOCIDX4.js";
export { REGDAT4 } from "./lib/DisalabData/REGDAT4.js";
export { RIDNIDX4 } from "./lib/DisalabData/RIDNIDX4.js";
export { RLIDIDX4 } from "./lib/DisalabData/RLIDIDX4.js";
export { RLNKIDX4 } from "./lib/DisalabData/RLNKIDX4.js";
export { RLNMIDX4 } from "./lib/DisalabData/RLNMIDX4.js";
export { RLOCIDX4 } from "./lib/DisalabData/RLOCIDX4.js";
export { RLSXIDX4 } from "./lib/DisalabData/RLSXIDX4.js";
export { RNAMIDX4 } from "./lib/DisalabData/RNAMIDX4.js";
export { RREFIDX4 } from "./lib/DisalabData/RREFIDX4.js";
export { RSNXIDX4 } from "./lib/DisalabData/RSNXIDX4.js";
export { RTKNIDX5 } from "./lib/DisalabData/RTKNIDX5.js";
export { STOADAT5 } from "./lib/DisalabData/STOADAT5.js";
export { TESTDATA } from "./lib/DisalabData/TESTDATA.js";
export { TXT1DATA } from "./lib/DisalabData/TXT1DATA.js";
export { WLSTDAT6 } from "./lib/DisalabData/WLSTDAT6.js";

export { SpecimenRecpt } from "./lib/Forms/specimenrecpt.js";
