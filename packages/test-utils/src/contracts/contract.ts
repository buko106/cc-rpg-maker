/** アダプタのインスタンスを作るファクトリ。契約テストはアダプタごとに新しいインスタンスを作る。 */
export type ContractFactory<T> = () => T | Promise<T>;
