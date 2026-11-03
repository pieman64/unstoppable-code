package com.unstoppabledomains.canopy

import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsAnimation
import androidx.annotation.RequiresApi

/**
 * Reconciles Flutter's cached IME insets with Android after an animation ends.
 *
 * Flutter can replay an obsolete keyboard height when an opening animation is
 * interrupted by background/resume (flutter/flutter#191156). Request a fresh
 * platform dispatch after Flutter's own end callback has run. Keep this callback
 * on the content parent: Flutter owns both inset callbacks on its FlutterView.
 * Normal animated insets continue through the subtree unchanged.
 */
@RequiresApi(Build.VERSION_CODES.R)
internal class ImeInsetsRecovery(private val content: View) {
    private val refresh = Runnable {
        if (content.isAttachedToWindow) content.requestApplyInsets()
    }

    init {
        content.setWindowInsetsAnimationCallback(
            object : WindowInsetsAnimation.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onProgress(
                    insets: WindowInsets,
                    runningAnimations: MutableList<WindowInsetsAnimation>,
                ): WindowInsets = insets

                override fun onEnd(animation: WindowInsetsAnimation) {
                    if (animation.typeMask and WindowInsets.Type.ime() != 0) {
                        content.removeCallbacks(refresh)
                        content.post(refresh)
                    }
                }
            },
        )
    }

    fun dispose() {
        content.removeCallbacks(refresh)
        content.setWindowInsetsAnimationCallback(null)
    }
}
