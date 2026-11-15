import { enableDisplayValidation } from "./display-validation";
import { registerLayoutInteractionMotionTests } from "../motion/layout-interaction-motion-cases";

enableDisplayValidation();
registerLayoutInteractionMotionTests("display");
