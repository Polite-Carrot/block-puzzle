import UIKit
import WebKit
import Capacitor

/* The long-press magnifier is UIKit text-interaction UI that sits underneath
   the web content, so CSS user-select and preventDefault on selectstart never
   reach it. Nothing in the game is selectable text, so it is switched off at
   the web view instead. The seed field still accepts typing and paste. */
class MainViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        if #available(iOS 14.5, *) {
            configuration.preferences.isTextInteractionEnabled = false
        }
        return configuration
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        /* iOS 16 regressed isTextInteractionEnabled, so the loupe and
           selection recognisers are disabled directly too. They live on the
           private WKContentView, which only exists once the web view has
           been laid out. */
        disableTextGestures(in: webView)
    }

    private func disableTextGestures(in view: UIView?) {
        guard let view = view else { return }
        for recognizer in view.gestureRecognizers ?? [] {
            let name = String(describing: type(of: recognizer))
            if name.contains("Loupe") || name.contains("TextSelection")
                || name.contains("TextInteraction") || name.contains("ForcePress") {
                recognizer.isEnabled = false
            }
        }
        for subview in view.subviews {
            disableTextGestures(in: subview)
        }
    }
}
