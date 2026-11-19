/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_WindowsUtilsChild_h_
#define mozilla_dom_WindowsUtilsChild_h_

#include "mozilla/dom/PWindowsUtilsChild.h"

namespace mozilla::dom {

// Manager for utilities in the WindowsUtils utility process.
class WindowsUtilsChild final : public PWindowsUtilsChild {
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(WindowsUtilsChild, override);

 protected:
  ~WindowsUtilsChild() = default;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_WindowsUtilsChild_h_
