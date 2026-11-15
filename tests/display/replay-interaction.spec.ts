import { enableDisplayValidation } from "./display-validation";
import { registerReplayInteractionTests } from "../motion/replay-interaction-cases";

enableDisplayValidation();
registerReplayInteractionTests("display");
