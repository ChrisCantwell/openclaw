import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import {
  encodeServiceChildMessage,
  type ServiceChildControlMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";

/** Encode and deliver relay control frames over IPC (Job anchor) or the control pipe (POSIX). */
export function createServiceChildMessaging(params: {
  child: ChildProcess;
  control: Duplex | null;
  useWindowsJobAnchor: boolean;
}): {
  sendChildMessage: (message: ServiceChildStart | ServiceChildControlMessage) => Promise<void>;
  sendControlMessage: (message: ServiceChildControlMessage) => Promise<void>;
} {
  const { child, control, useWindowsJobAnchor } = params;
  const sendChildMessage = (
    message: ServiceChildStart | ServiceChildControlMessage,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("service child lifecycle IPC is closed"));
        return;
      }
      child.send(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

  const sendControlMessage = (message: ServiceChildControlMessage): Promise<void> => {
    if (useWindowsJobAnchor) {
      return sendChildMessage(message);
    }
    return new Promise((resolve, reject) => {
      if (!control || control.destroyed) {
        reject(new Error("service child control pipe is closed"));
        return;
      }
      control.write(encodeServiceChildMessage(message), "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };
  return { sendChildMessage, sendControlMessage };
}
