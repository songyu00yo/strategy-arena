import { enableDisplayValidation } from "./display-validation";
import { registerInteractionCoverageTests } from "../motion/interaction-coverage-cases";

enableDisplayValidation();
registerInteractionCoverageTests("display");
