declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
  }

  export interface RfbOptions {
    credentials?: RfbCredentials;
    wsProtocols?: string[];
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    scaleViewport: boolean;
    focusOnClick: boolean;
    addEventListener(
      type: "connect" | "disconnect" | "securityfailure",
      listener: (event: CustomEvent) => void,
    ): void;
    removeEventListener(
      type: "connect" | "disconnect" | "securityfailure",
      listener: (event: CustomEvent) => void,
    ): void;
    sendKey(keysym: number, code: string | undefined, down?: boolean): void;
    sendCtrlAltDel(): void;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}