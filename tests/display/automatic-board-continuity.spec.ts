import { registerAutomaticBoardContinuityTests } from "../motion/automatic-board-continuity-cases";
import { enableDisplayValidation } from "./display-validation";

enableDisplayValidation();
registerAutomaticBoardContinuityTests("display");
