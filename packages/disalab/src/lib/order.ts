export class Order<T = unknown> {
  CODE: string;
  ORDERS: T[];

  constructor(code: string, orders: T[]) {
    this.CODE = code;
    this.ORDERS = orders;
  }
}
