# slowbicycle

`slowroads.io`의 끝없는 드라이빙 감성을 자전거의 페달링, 경사, 기울기로 재해석한 브라우저 라이딩 시뮬레이션입니다.

라이브: [slowbicycle.pages.dev](https://slowbicycle.pages.dev/)

## 실행

```bash
npm install
npm run dev
```

키보드 `W`/`Space`로 페달, `S`로 브레이크, `A`/`D` 또는 방향키로 조향합니다. `Esc`로 일시정지하고 `H`로 HUD를 숨길 수 있습니다.

`Space`는 한 번 누를 때마다 크랭크가 반 바퀴 감기며 짧은 가속과 카메라 펄스를 만듭니다. 화면에는 사람 없이 로드바이크만 표시됩니다.

## 검증

```bash
npm test
npm run build
```

두 검증을 한 번에 실행하려면 `npm run check`를 사용합니다.

## Cloudflare Pages

Wrangler 인증 후 `npm run deploy:pages`를 실행하면 `dist`가 `slowbicycle` Pages 프로젝트의 프로덕션 브랜치에 배포됩니다.

상세 기획은 [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md)를 참고하세요.
