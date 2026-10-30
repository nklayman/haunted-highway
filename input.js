// Conspit MAX 01 wheel controls via the Gamepad API (mapping "none", 32 buttons, 10 axes).
// Chrome only exposes the pad after a button press while the page has focus.

const WHEEL_ID = /CONSPIT MAX 01|Vendor: 3514 Product: 000f/i;

const BUTTONS = { leftThumb: 0, rightThumb: 9, leftPaddle: 10, rightPaddle: 11 };
const AXES = { leftClutch: 0, rightClutch: 1 }; // rest -1, fully pulled +1

export function findWheel() {
  return [...navigator.getGamepads()].find((p) => p && WHEEL_ID.test(p.id)) || null;
}

// Call once per frame. Returns current state plus `pressed`/`released` edges since last call.
export function createWheelInput() {
  let prev = {};
  return function poll() {
    const pad = findWheel();
    const state = { connected: !!pad, pressed: {}, released: {} };
    for (const [name, i] of Object.entries(BUTTONS)) {
      const down = !!pad?.buttons[i]?.pressed;
      state[name] = down;
      if (down && !prev[name]) state.pressed[name] = true;
      if (!down && prev[name]) state.released[name] = true;
    }
    for (const [name, i] of Object.entries(AXES)) {
      state[name] = pad ? (pad.axes[i] + 1) / 2 : 0; // normalised 0..1
    }
    prev = state;
    return state;
  };
}
