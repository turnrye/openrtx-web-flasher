// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Every method's simulated radios, as one module: the drivers load this, and only when a
 * simulated radio is first asked for, so the page of someone flashing a real radio never
 * downloads a simulator. One module and not one per method, so that the simulators stay
 * one download beside the page's own code.
 */
export { cs7000RobotSim } from './cs7000-robot.sim.ts';
export { cskSerialSim } from './csk-serial.sim.ts';
export { gd77HidSim } from './gd77-hid.sim.ts';
export { rt4dSerialSim } from './rt4d-serial.sim.ts';
export { rt950SerialSim } from './rt950-serial.sim.ts';
export { stm32DfuSim } from './stm32-dfu.sim.ts';
export { tytDfuSim } from './tyt-dfu.sim.ts';
