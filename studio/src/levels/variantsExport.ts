/** Offers bytes as a download (same blob and anchor pattern as the native-source export). */
export function downloadBytes(fileName: string, bytes: Uint8Array<ArrayBuffer>, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
