import { bindEvents, addPersonaButton } from "./src/ui/events.js";
import { log } from "./src/log.js";

jQuery(async () => {
    addPersonaButton();
    bindEvents();
    log("Persona Weaver loaded");
});
