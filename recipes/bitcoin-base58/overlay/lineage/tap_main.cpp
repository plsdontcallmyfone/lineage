// TAP runner for upstream tests compiled against lineage/shim (overlay, protected).
#include <boost/test/unit_test.hpp>

#include <exception>

int main()
{
    auto& cases = lineage_test::registry();
    int n = 0, bad = 0;
    for (auto& c : cases) {
        int before = lineage_test::failures();
        bool threw = false;
        try {
            c.fn();
        } catch (const std::exception& e) {
            threw = true;
            std::cout << "# exception: " << e.what() << "\n";
        }
        bool ok = !threw && lineage_test::failures() == before;
        if (!ok) ++bad;
        std::cout << (ok ? "ok " : "not ok ") << ++n << " - " << c.suite << "::" << c.name << "\n";
    }
    std::cout << "1.." << n << "\n";
    return bad ? 1 : 0;
}
