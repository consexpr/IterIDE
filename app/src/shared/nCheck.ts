/**
 * n-check: ITER's own checker protocol (docs/n-check.md). A checker is one C++ file that needs nothing
 * but <bits/stdc++.h>; ITER runs it as `checker <input> <output> <answer>` and reads the verdict from
 * the exit code and the message from the first line of stderr.
 */
export const N_CHECK_FILE = 'checker-n-check.cpp'

export const N_CHECK_TEMPLATE = `// n-check 1
#include <bits/stdc++.h>
using namespace std;

// argv[1] = input, argv[2] = contestant output, argv[3] = jury answer.
// Exit code: 0 = AC, 1 = WA, 2 = PE, anything else = checker failure. The first line of stderr is the message.
[[noreturn]] static void verdict(int code, const string& message = "") {
    if (!message.empty()) cerr << message << endl;
    exit(code);
}

int main(int argc, char** argv) {
    if (argc < 4) verdict(3, "usage: checker <input> <output> <answer>");
    ifstream in(argv[1]), out(argv[2]), ans(argv[3]);

    long long expected, found;
    if (!(ans >> expected)) verdict(3, "answer file is empty");
    if (!(out >> found)) verdict(2, "no number in the output");
    if (found != expected) verdict(1, "expected " + to_string(expected) + ", found " + to_string(found));
    verdict(0);
}
`
