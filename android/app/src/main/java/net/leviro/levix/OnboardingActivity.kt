package net.leviro.levix

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class OnboardingActivity : AppCompatActivity() {
    private var step = 0
    private var replay = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_onboarding)
        replay = intent.getBooleanExtra(EXTRA_REPLAY, false)
        step = savedInstanceState?.getInt("step") ?: 0
        findViewById<Button>(R.id.guideSkip).setOnClickListener { complete() }
        findViewById<Button>(R.id.guideNext).setOnClickListener {
            if (step == 2) complete() else { step++; render() }
        }
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("step", step)
        super.onSaveInstanceState(outState)
    }

    private fun render() {
        val titles = intArrayOf(R.string.guide_what_title, R.string.guide_connect_title,
            R.string.guide_privacy_title)
        val bodies = intArrayOf(R.string.guide_what_body, R.string.guide_connect_body,
            R.string.guide_privacy_body)
        findViewById<TextView>(R.id.guideProgress).text = getString(R.string.guide_step, step + 1)
        findViewById<TextView>(R.id.guideTitle).setText(titles[step])
        findViewById<TextView>(R.id.guideBody).setText(bodies[step])
        findViewById<Button>(R.id.guideNext).setText(
            if (step == 2) R.string.guide_done else R.string.guide_next)
    }

    private fun complete() {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_COMPLETED, true).apply()
        if (!replay) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    companion object {
        private const val PREFS = "levix_onboarding"
        private const val KEY_COMPLETED = "onboarding_completed"
        private const val EXTRA_REPLAY = "replay"

        fun completed(context: Context): Boolean = context.getSharedPreferences(PREFS,
            Context.MODE_PRIVATE).getBoolean(KEY_COMPLETED, false)

        fun showAgain(context: Context) {
            context.startActivity(Intent(context, OnboardingActivity::class.java)
                .putExtra(EXTRA_REPLAY, true))
        }
    }
}
