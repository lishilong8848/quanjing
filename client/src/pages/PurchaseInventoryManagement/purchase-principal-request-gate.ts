export class PurchasePrincipalRequestGate {
  private principalKey: string;
  private generation = 0;

  constructor(principalKey: string) {
    this.principalKey = principalKey;
  }

  syncPrincipal(principalKey: string): number {
    if (principalKey !== this.principalKey) {
      this.principalKey = principalKey;
      this.generation += 1;
    }
    return this.generation;
  }

  capture(): number {
    return this.generation;
  }

  isCurrent(requestGeneration: number): boolean {
    return requestGeneration === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
