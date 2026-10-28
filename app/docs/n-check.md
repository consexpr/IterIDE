# n-check 协议

n-check 是 ITER 自己的 Special Judge 协议：一个只依赖 `<bits/stdc++.h>` 的 C++ 文件，不需要 `testlib.h`。它和 testlib 检查器并存，两种都能用。

## 怎么用

在灵动岛的 **结果检查 → checker** 中，点 **设置 / 编辑** 输入 n-check 或 testlib 源码，再点 **使用此 checker**。不再提供单独选择 checker 文件的按钮；拖入文件夹或 ZIP 自动识别的 checker 也在同一个窗口显示与编辑。

新源码从兼容旧版的 `checker-n-check.cpp` 入口保存，再纳入中央依赖缓存；文件名不参与协议判断。再次打开会读取当前 checker 的实际源码，编辑导入的 checker 会创建新的依赖缓存副本，保留配套头文件和资源，不改写导入源文件。没有源码的历史二进制 checker 仍可在此调整参数或粘贴源码替换。grader 的联合编译文件独立保留。

## 协议（版本 1）

默认使用以下三个文件参数：

```
checker <input> <output> <answer>
```

| 参数      | 内容               |
| --------- | ------------------ |
| `argv[1]` | 测试点的输入文件   |
| `argv[2]` | 选手程序的输出文件 |
| `argv[3]` | 标准答案文件       |

结果由**退出码**决定，说明文字写到 **stderr**（只取内容，显示给用户）：

| 退出码 | 判定                                               |
| ------ | -------------------------------------------------- |
| `0`    | AC                                                 |
| `1`    | WA                                                 |
| `2`    | PE（格式错误）                                     |
| 其他   | SE（检查器自身出错，例如参数不对、答案文件读不了） |

其他约定：

- 检查器 10 秒内必须结束，超时记为 SE。
- 工作目录是输出文件所在目录。三个路径都是可以直接打开的文件路径。
- 编译使用 C++17 和 O2，默认提供 `testlib.h` 的搜索路径，但不会自动 include 它。
- 可选：文件第一行写 `// n-check 1` 标明协议版本，ITER 不依赖它。
- 窗口内的参数控件按从左到右的顺序传给 `argv[1]`、`argv[2]` 等。可以只留答案、答案和输出、改变顺序、重复或移除全部参数。空参数配置表示不传任何文件，不会回退到三个默认参数。源码中的 `argv` 下标应与配置对应。
- 参数控件保存在题目的 `checker.args`。已有含固定选项或 `{score}` 的高级模板原样保留，并显示模板输入框。

## 与 testlib 的区别

ITER 看检查器源码里有没有 `#include <testlib.h>`（或 `"testlib.h"`）：

- **有**：按 testlib 检查器识别，退出码 `0/7` → AC，`1` → WA，`2` → PE，其他 → SE。
- **没有**：有 `// n-check 1` 标记时显示为 n-check，无明确标记时显示“待核对”。头文件始终可用，宏或间接 include 也能正常编译；是否引用它由源码决定。

识别会忽略注释和字符串中的示例代码。testlib 的 `registerTestlibCmd`、`registerInteraction` 和校验器注册调用会区分职责；交互器、校验器、生成器不能当成 checker 保存。协议识别不会覆盖用户配置的参数顺序。

两者的运行方式（参数顺序、退出码、stderr 作为说明）完全一致，所以 n-check 的退出码约定就是 testlib 的子集；差别只是不需要那个头文件。

## 示例

比较两个整数，允许选手输出多余空白：

```cpp
// n-check 1
#include <bits/stdc++.h>
using namespace std;

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
```

答案不唯一的题目：读 `argv[1]` 取得题目数据，读 `argv[2]` 验证选手构造的解是否合法，不必读 `argv[3]`。
