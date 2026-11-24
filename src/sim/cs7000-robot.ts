// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Simulated Connect Systems CS7000-M17 Plus in robot mode: a USB drive without a disk
 * whose two vendor SCSI commands carry the bootloader's frames.
 *
 * It is strict on purpose, on both layers. A transfer out of step with the Bulk-Only
 * Transport, a wrapper with the wrong size or signature, a SCSI command the flasher has
 * no business sending, a frame that does not unscramble to a sound one, a block out of
 * order or a commit before the last block is listed in `violations`. What a real radio
 * does when asked for an answer it does not have is not known, so `idle` picks among
 * the ways a USB drive can say so and the flasher is tested against each.
 */
import {
  DATA_TAG,
  ROBOT_ANSWER,
  ROBOT_BLOCK,
  RobotCommand,
  parseRobotFrame,
  robotFrame,
  scramble,
} from '../flash/cs7000-robot.ts';
import {
  BULK_ONLY_RESET,
  CBW_DATA_IN,
  CBW_SIGNATURE,
  CBW_SIZE,
  CSW_SIGNATURE,
  CSW_SIZE,
} from '../flash/usb-storage.ts';

const INTERFACE = 0;
const ENDPOINT = 1;
/** The radio's answers to a connect, and to a block or a commit. */
const CONNECTED = 0x24;
const ACCEPTED = 0x21;

/** How the simulated radio answers a fetch when it has nothing to say. */
export type SimIdle =
  /** The command passes with a full buffer of zeroes. */
  | 'zeroes'
  /** The command fails and the status wrapper comes in place of the data. */
  | 'skip'
  /** The command fails and the data stage stalls. */
  | 'stall'
  /** The radio sends nothing until the host gives up and resets the transport. */
  | 'timeout';

/** Options for the simulated radio. */
export interface SimCs7000RobotOptions {
  /** What a fetch with nothing to fetch looks like; default 'zeroes'. */
  idle?: SimIdle;
  /** When false, an answer is sent as it is, not filled up with zeroes. Default true. */
  padAnswers?: boolean;
  /** When true, the radio takes frames and never answers them. */
  silent?: boolean;
  /** Answer the block with this index with something other than the usual byte. */
  oddAnswerAt?: number;
}

/** Bytes of a BufferSource. */
function toBytes(data: BufferSource): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** A DataView over a copy of `bytes`. */
function view(bytes: Uint8Array): DataView {
  const copy = bytes.slice();
  return new DataView(copy.buffer);
}

/** Where a Bulk-Only command stands. */
type Stage =
  | { at: 'command' }
  | { at: 'data-out'; tag: number; cdb: Uint8Array; length: number }
  | { at: 'data-in'; tag: number; data: Uint8Array; status: number; stall: boolean }
  | { at: 'hung' }
  | { at: 'status'; tag: number; status: number; residue: number };

/** Simulated robot-mode bootloader on USB. */
export class SimCs7000Robot {
  readonly vendorId = 0x0483;
  readonly productId = 0x5720;
  readonly productName = 'Mass Storage in FS Mode';
  readonly manufacturerName = 'STMicroelectronics';
  readonly serialNumber = 'SIM0001';
  opened = false;
  /** Mistakes the host made, in order; empty after a clean session. */
  readonly violations: string[] = [];
  /** Commands of the frames taken, in order. */
  readonly frames: number[] = [];
  /** True once a commit followed the last block. */
  committed = false;

  private configured = false;
  private claimed = false;
  private stage: Stage = { at: 'command' };
  private halted = { in: false, out: false };
  private answer: Uint8Array | null = null;
  private connected = false;
  private total: number | null = null;
  private next = 0;
  private received = new Uint8Array(0);
  private readonly options: Required<Omit<SimCs7000RobotOptions, 'oddAnswerAt'>> & { oddAnswerAt?: number };

  /** Builds a closed, unconfigured radio. */
  constructor(options: SimCs7000RobotOptions = {}) {
    this.options = { idle: 'zeroes', padAnswers: true, silent: false, ...options };
  }

  /** The image the radio holds: what the blocks carried, cut to the size they announced. */
  get image(): Uint8Array {
    return this.received.slice(0, this.total ?? 0);
  }

  /** The only configuration: one Bulk-Only SCSI interface with a bulk endpoint each way. */
  get configurations(): USBConfiguration[] {
    const endpoint = (direction: USBDirection): USBEndpoint => ({
      endpointNumber: ENDPOINT,
      direction,
      type: 'bulk',
      packetSize: 64,
    });
    const alternate: USBAlternateInterface = {
      alternateSetting: 0,
      interfaceClass: 0x08,
      interfaceSubclass: 0x06,
      interfaceProtocol: 0x50,
      interfaceName: 'MSC Interface',
      endpoints: [endpoint('in'), endpoint('out')],
    };
    return [
      {
        configurationValue: 1,
        configurationName: null,
        interfaces: [
          { interfaceNumber: INTERFACE, alternate, alternates: [alternate], claimed: this.claimed },
        ],
      },
    ];
  }

  /** The active configuration, null until one is selected. */
  get configuration(): USBConfiguration | null {
    return this.configured ? this.configurations[0] : null;
  }

  /** Opens the device. */
  async open(): Promise<void> {
    this.opened = true;
  }

  /** Closes the device and drops its claim. */
  async close(): Promise<void> {
    this.opened = false;
    this.claimed = false;
  }

  /** Selects configuration 1, the only one. */
  async selectConfiguration(configurationValue: number): Promise<void> {
    this.requireOpen();
    if (configurationValue !== 1) throw new Error('NotFoundError: no such configuration');
    this.configured = true;
  }

  /** Claims the mass-storage interface. */
  async claimInterface(interfaceNumber: number): Promise<void> {
    this.requireOpen();
    if (!this.configured) throw new Error('InvalidStateError: no configuration selected');
    if (interfaceNumber !== INTERFACE) throw new Error('NotFoundError: no such interface');
    this.claimed = true;
  }

  /** Releases the mass-storage interface. */
  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.requireClaimed(interfaceNumber);
    this.claimed = false;
  }

  /** Clears a stalled endpoint. */
  async clearHalt(direction: USBDirection, endpointNumber: number): Promise<void> {
    this.requireClaimed(INTERFACE);
    if (endpointNumber !== ENDPOINT) throw new Error('NotFoundError: no such endpoint');
    this.halted[direction] = false;
  }

  /** Host-to-device control transfer: only the Bulk-Only reset. */
  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    this.requireOpen();
    if (setup.requestType !== 'class' || setup.request !== BULK_ONLY_RESET || setup.index !== INTERFACE) {
      this.violations.push(`unexpected control request ${setup.request}`);
      return { status: 'stall', bytesWritten: 0 };
    }
    this.stage = { at: 'command' };
    return { status: 'ok', bytesWritten: 0 };
  }

  /** Bulk transfer to the radio: a command wrapper, or the data of a command. */
  async transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult> {
    this.requireEndpoint(endpointNumber);
    const bytes = toBytes(data).slice();
    if (this.halted.out) return { status: 'stall', bytesWritten: 0 };
    if (this.stage.at === 'command') {
      this.command(bytes);
    } else if (this.stage.at === 'data-out') {
      const { tag, cdb, length } = this.stage;
      if (bytes.length !== length)
        this.violations.push(`data of ${bytes.length} bytes, wrapper said ${length}`);
      this.stage = { at: 'status', tag, status: this.sent(cdb, bytes) ? 0 : 1, residue: 0 };
    } else {
      this.violations.push(`bytes sent while the radio had ${this.stage.at} to send`);
    }
    return { status: 'ok', bytesWritten: bytes.length };
  }

  /** Bulk transfer from the radio: the data of a command, or its status wrapper. */
  async transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult> {
    this.requireEndpoint(endpointNumber);
    if (this.halted.in) return { status: 'stall' };
    if (this.stage.at === 'hung') throw new Error('transferIn error: Error: LIBUSB_TRANSFER_TIMED_OUT');
    if (this.stage.at === 'data-in') {
      const { tag, data, status, stall } = this.stage;
      this.stage = { at: 'status', tag, status, residue: 0 };
      if (stall) {
        this.halted.in = true;
        return { status: 'stall' };
      }
      // With no data to send, the status wrapper comes in its place.
      if (data.length === 0) return this.transferIn(endpointNumber, length);
      return { status: 'ok', data: view(data.subarray(0, length)) };
    }
    if (this.stage.at === 'status') {
      const { tag, status, residue } = this.stage;
      this.stage = { at: 'command' };
      const csw = new Uint8Array(CSW_SIZE);
      const fields = new DataView(csw.buffer);
      fields.setUint32(0, CSW_SIGNATURE, true);
      fields.setUint32(4, tag, true);
      fields.setUint32(8, residue, true);
      csw[12] = status;
      return { status: 'ok', data: view(csw.subarray(0, length)) };
    }
    this.violations.push('bytes asked for while the radio waited for a command');
    throw new Error('transferIn error: LIBUSB_TRANSFER_TIMED_OUT');
  }

  /** A command wrapper arrived. */
  private command(cbw: Uint8Array): void {
    const fields = new DataView(cbw.buffer, cbw.byteOffset, cbw.byteLength);
    if (cbw.length !== CBW_SIZE || fields.getUint32(0, true) !== CBW_SIGNATURE) {
      this.violations.push(`a command wrapper of ${cbw.length} bytes that is not one`);
      this.halted.in = this.halted.out = true;
      return;
    }
    const tag = fields.getUint32(4, true);
    const length = fields.getUint32(8, true);
    const dataIn = (cbw[12] & CBW_DATA_IN) !== 0;
    const cdb = cbw.slice(15, 15 + cbw[14]);
    if (cbw[13] !== 0) this.violations.push(`command for logical unit ${cbw[13]}`);

    if (!dataIn) {
      this.stage = { at: 'data-out', tag, cdb, length };
      return;
    }
    const isFetch =
      cdb.length === 16 && cdb[0] === 0xff && cdb[1] === 0x28 && cdb[14] === 0x47 && cdb[15] === 0x50;
    if (cdb[0] === 0x03) {
      // REQUEST SENSE: fixed format, "no sense".
      const sense = new Uint8Array(18);
      sense[0] = 0x70;
      sense[7] = 10;
      this.stage = { at: 'data-in', tag, data: sense.subarray(0, length), status: 0, stall: false };
    } else if (!isFetch) {
      this.violations.push(`unexpected SCSI command ${cdb[0].toString(16)}`);
      this.stage = { at: 'data-in', tag, data: new Uint8Array(0), status: 1, stall: true };
    } else if (this.answer) {
      const data = this.options.padAnswers ? new Uint8Array(length) : new Uint8Array(this.answer.length);
      data.set(this.answer.subarray(0, data.length));
      this.answer = null;
      this.stage = { at: 'data-in', tag, data, status: 0, stall: false };
    } else if (this.options.idle === 'zeroes') {
      this.stage = { at: 'data-in', tag, data: new Uint8Array(length), status: 0, stall: false };
    } else if (this.options.idle === 'timeout') {
      this.stage = { at: 'hung' };
    } else {
      const stall = this.options.idle === 'stall';
      this.stage = { at: 'data-in', tag, data: new Uint8Array(0), status: 1, stall };
    }
  }

  /** The data of a host-to-device command arrived; false fails the command. */
  private sent(cdb: Uint8Array, data: Uint8Array): boolean {
    const isSend =
      cdb.length === 16 && cdb[0] === 0xff && cdb[1] === 0x2a && cdb[14] === 0x47 && cdb[15] === 0x50;
    if (!isSend) {
      this.violations.push(`unexpected SCSI command ${cdb[0].toString(16)} with data`);
      return false;
    }
    const frame = parseRobotFrame(scramble(data));
    if (!frame) {
      this.violations.push('a frame that does not unscramble to a sound one');
      return true;
    }
    this.frames.push(frame.command);
    const payload = this.take(frame.command, frame.payload);
    if (payload && !this.options.silent) this.answer = robotFrame(frame.command | ROBOT_ANSWER, payload);
    return true;
  }

  /** Acts on a frame; returns the payload of the answer, or null for none. */
  private take(command: number, payload: Uint8Array): Uint8Array | null {
    switch (command) {
      case RobotCommand.CONNECT:
        if (payload.length !== 3 || payload[0] !== 1 || payload[1] !== 2 || payload[2] !== 0xff) {
          this.violations.push('a connect frame with the wrong payload');
          return null;
        }
        this.connected = true;
        this.total = null;
        this.next = 0;
        this.committed = false;
        return Uint8Array.of(CONNECTED);
      case RobotCommand.DATA:
        return this.block(payload);
      case RobotCommand.COMMIT: {
        const blocks = this.total === null ? 0 : Math.ceil(this.total / ROBOT_BLOCK);
        if (!this.connected || this.total === null || this.next !== blocks) {
          this.violations.push(`a commit after ${this.next} of ${blocks} blocks`);
          return null;
        }
        this.committed = true;
        return Uint8Array.of(ACCEPTED);
      }
      default:
        this.violations.push(`unknown frame command ${command.toString(16)}`);
        return null;
    }
  }

  /** Takes one data block. */
  private block(payload: Uint8Array): Uint8Array | null {
    const fields = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (!this.connected) {
      this.violations.push('a block before the connect');
      return null;
    }
    if (
      payload.length !== 9 + ROBOT_BLOCK ||
      payload[0] !== DATA_TAG ||
      fields.getUint16(7) !== ROBOT_BLOCK
    ) {
      this.violations.push('a block with a malformed header');
      return null;
    }
    const index = fields.getUint16(1);
    const total = fields.getUint32(3);
    if (index !== this.next || (this.total !== null && total !== this.total)) {
      this.violations.push(`block ${index} of a ${total}-byte image, expected block ${this.next}`);
      return null;
    }
    if (this.total === null) {
      this.total = total;
      this.received = new Uint8Array(Math.ceil(total / ROBOT_BLOCK) * ROBOT_BLOCK);
    }
    if ((index + 1) * ROBOT_BLOCK > this.received.length) {
      this.violations.push(`block ${index} past the end of the image`);
      return null;
    }
    this.received.set(payload.subarray(9), index * ROBOT_BLOCK);
    this.next = index + 1;
    return Uint8Array.of(index === this.options.oddAnswerAt ? 0x00 : ACCEPTED);
  }

  /** Rejects when the device is closed, as WebUSB does. */
  private requireOpen(): void {
    if (!this.opened) throw new Error('InvalidStateError: the device is not open');
  }

  /** Rejects when the interface is not claimed, as WebUSB does. */
  private requireClaimed(interfaceNumber: number): void {
    this.requireOpen();
    if (interfaceNumber !== INTERFACE || !this.claimed) {
      throw new Error('InvalidStateError: the interface is not claimed');
    }
  }

  /** Rejects a transfer on anything but the claimed interface's endpoint. */
  private requireEndpoint(endpointNumber: number): void {
    this.requireClaimed(INTERFACE);
    if (endpointNumber !== ENDPOINT) throw new Error('NotFoundError: no such endpoint');
  }
}
