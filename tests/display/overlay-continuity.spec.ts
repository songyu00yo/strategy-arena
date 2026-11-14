import { registerOverlayContinuityTests } from "../motion/overlay-continuity-cases";
import { enableDisplayValidation } from "./display-validation";

enableDisplayValidation();
registerOverlayContinuityTests("display");
