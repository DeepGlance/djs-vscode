/// The root of the public fixture of the djs-vscode host tests (BSL-1.0, see LICENSE).
module app;

import geom;

enum side = 4 * 4;

mixin("int generated = 3;");

version (Fixture)
    enum target = "fixture";
else
    enum target = "other";

/// `value` times `factor`.
int scale(int value, int factor)
{
    return value * factor;
}

int main()
{
    auto a = Vec!int(1, 2);
    auto b = a + Vec!int(3, 4);
    auto d = Vec!double(0.5, 1.5);
    auto n = Named("n", b);
    int total = scale(b.length2, side) + n.x + generated;
    return total > 0 && d.x < 1 ? 0 : 1;
}
