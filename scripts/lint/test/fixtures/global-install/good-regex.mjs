// A regex that checks generated text does not install anything.
export const re = /npm install -g coding\.sh@\d+/;
// npm install -g in a comment is not a command.
export const local = ["install", "--prefix", "/tmp/x"];
