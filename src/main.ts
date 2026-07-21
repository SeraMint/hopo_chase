import "./style.css";

import { Game } from "./game/Game";

const canvas =
  document.querySelector<HTMLCanvasElement>(
    "#game-canvas",
  );

if (!canvas) {
  throw new Error(
    "HTML 요소를 찾지 못했습니다: #game-canvas",
  );
}

const game = new Game(canvas);

game.start();
