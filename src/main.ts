import "./style.css";
import { SlowBicycleGame } from "./game/game";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container not found");

new SlowBicycleGame(app);
