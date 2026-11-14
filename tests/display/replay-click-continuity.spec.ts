import { registerReplayClickContinuityTests } from "../motion/replay-click-continuity-cases";
import { enableDisplayValidation } from "./display-validation";

enableDisplayValidation();
registerReplayClickContinuityTests("display");
