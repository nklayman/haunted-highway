// Conspit MAX 01 wheel controls via the Gamepad API.
// Windows Chrome: mapping "none", 32 buttons, 10 axes, D-pad on hat axis 9.
// Android Chrome: only standard-gamepad inputs survive — the clutch axes and the
// D-pad (standard buttons 12-15, or arrow-key events) — not paddles/thumb buttons.
// Chrome only exposes the pad after a button press while the page has focus.

const WHEEL_ID = /CONSPIT MAX 01|Vendor: 3514 Product: 000f/i;
const ANDROID = /Android/i.test(navigator.userAgent);

const BUTTONS = { leftThumb: 0, rightThumb: 9, leftPaddle: 10, rightPaddle: 11 };
const AXES = { leftClutch: 0, rightClutch: 1 }; // rest -1, fully pulled +1
const HAT_AXIS = 9;
const STANDARD_DPAD = { dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15 };

export function findWheel() {
  const pads = [...navigator.getGamepads()].filter(Boolean);
  // Android may report a different id; the wheel is then the only pad that matters.
  return pads.find((p) => WHEEL_ID.test(p.id)) || (ANDROID ? pads[0] : null) || null;
}

// Chrome encodes a hat switch as one axis: -1 = up, stepping 2/7 clockwise through
// the 8 directions; anything beyond ±1 means centred.
function readHat(v) {
  const dirs = { dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false };
  if (v == null || Math.abs(v) > 1.05) return dirs;
  const i = Math.round((v + 1) * 3.5) % 8; // 0 up, 1 up-right, 2 right, … 7 up-left
  dirs.dpadUp = i === 7 || i <= 1;
  dirs.dpadRight = i >= 1 && i <= 3;
  dirs.dpadDown = i >= 3 && i <= 5;
  dirs.dpadLeft = i >= 5 && i <= 7;
  return dirs;
}

// Call once per frame. Returns current state plus `pressed`/`released` edges since last call.
export function createWheelInput() {
  let prev = {};
  return function poll() {
    const pad = findWheel();
    const down = {};
    for (const [name, i] of Object.entries(BUTTONS)) down[name] = pad?.mapping !== 'standard' && !!pad?.buttons[i]?.pressed;
    const dpad = pad?.mapping === 'standard'
      ? Object.fromEntries(Object.entries(STANDARD_DPAD).map(([name, i]) => [name, !!pad.buttons[i]?.pressed]))
      : readHat(pad?.axes[HAT_AXIS]);
    Object.assign(down, dpad);

    const state = { connected: !!pad, pressed: {}, released: {}, ...down };
    for (const name of Object.keys(down)) {
      if (down[name] && !prev[name]) state.pressed[name] = true;
      if (!down[name] && prev[name]) state.released[name] = true;
    }
    for (const [name, i] of Object.entries(AXES)) {
      state[name] = pad ? (pad.axes[i] + 1) / 2 : 0; // normalised 0..1
    }
    prev = state;
    return state;
  };
}
