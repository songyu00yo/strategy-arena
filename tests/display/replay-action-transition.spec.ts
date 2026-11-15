import { enableDisplayValidation } from "./display-validation";
import { registerReplayActionTransitionTests } from "../motion/replay-action-transition-cases";

enableDisplayValidation();
registerReplayActionTransitionTests("display");
