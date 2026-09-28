from unittest.mock import Mock, call, patch

import requests
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory

from uml_api.services.services_gemini import (
    GeminiResponseError,
    GeminiTimeoutError,
    GeminiUnavailableError,
    _request_gemini,
    call_gemini,
)
from uml_api.views import GenerateUMLView


def response(status_code, payload=None, json_error=None):
    mocked = Mock(status_code=status_code)
    if json_error is not None:
        mocked.json.side_effect = json_error
    else:
        mocked.json.return_value = payload
    return mocked


@override_settings(GEMINI_API_KEY="test-key")
class GeminiRequestTests(SimpleTestCase):
    @patch("uml_api.services.services_gemini.time.sleep")
    @patch("uml_api.services.services_gemini.requests.post")
    def test_retries_transient_errors_until_success(self, post, sleep):
        expected = {"candidates": []}
        post.side_effect = [
            response(503),
            response(503),
            response(200, expected),
        ]

        result = _request_gemini({"contents": []})

        self.assertEqual(result, expected)
        self.assertEqual(post.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    @patch("uml_api.services.services_gemini.time.sleep")
    @patch("uml_api.services.services_gemini.requests.post")
    def test_raises_unavailable_after_three_503_responses(self, post, sleep):
        post.side_effect = [response(503), response(503), response(503)]

        with self.assertRaises(GeminiUnavailableError):
            _request_gemini({"contents": []})

        self.assertEqual(post.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    @patch("uml_api.services.services_gemini.time.sleep")
    @patch("uml_api.services.services_gemini.requests.post")
    def test_retries_one_timeout_then_succeeds(self, post, sleep):
        expected = {"candidates": []}
        post.side_effect = [
            requests.Timeout("timeout"),
            response(200, expected),
        ]

        result = _request_gemini({"contents": []})

        self.assertEqual(result, expected)
        self.assertEqual(post.call_count, 2)
        sleep.assert_called_once_with(1)

    @patch("uml_api.services.services_gemini.time.sleep")
    @patch("uml_api.services.services_gemini.requests.post")
    def test_stops_after_two_timeouts(self, post, sleep):
        post.side_effect = requests.Timeout("timeout")

        with self.assertRaises(GeminiTimeoutError):
            _request_gemini({"contents": []})

        self.assertEqual(post.call_count, 2)
        sleep.assert_called_once_with(1)

    @patch("uml_api.services.services_gemini.requests.post")
    def test_does_not_retry_client_error(self, post):
        post.return_value = response(400)

        with self.assertRaises(GeminiResponseError):
            _request_gemini({"contents": []})

        post.assert_called_once()

    @patch("uml_api.services.services_gemini.requests.post")
    def test_rejects_non_json_response(self, post):
        post.return_value = response(200, json_error=ValueError("invalid"))

        with self.assertRaises(GeminiResponseError):
            _request_gemini({"contents": []})

        post.assert_called_once()

    @patch("uml_api.services.services_gemini._request_gemini")
    def test_includes_current_diagram_in_model_prompt(self, request_gemini):
        request_gemini.return_value = {
            "candidates": [{"content": {"parts": [{"text": "{}"}]}}]
        }
        current_diagram = {
            "classes": [{"id": "class-1", "name": "Cliente"}],
            "relationships": [],
        }

        call_gemini("elimina la clase Cliente", current_diagram)

        sent_text = request_gemini.call_args.args[0]["contents"][0]["parts"][0]["text"]
        self.assertIn("DIAGRAMA ACTUAL DEL USUARIO", sent_text)
        self.assertIn('"name": "Cliente"', sent_text)


class GenerateUMLViewErrorTests(SimpleTestCase):
    def setUp(self):
        self.factory = APIRequestFactory()
        self.view = GenerateUMLView.as_view()

    @patch("uml_api.views.call_gemini", side_effect=GeminiUnavailableError())
    def test_returns_503_when_provider_is_unavailable(self, _call_gemini):
        request = self.factory.post(
            "/api/chatbot/",
            {"prompt": "genera la clase Gato"},
            format="json",
        )

        result = self.view(request)

        self.assertEqual(result.status_code, 503)
        self.assertIn("temporalmente ocupado", result.data["error"])

    @patch("uml_api.views.call_gemini", side_effect=GeminiTimeoutError())
    def test_returns_504_when_provider_times_out(self, _call_gemini):
        request = self.factory.post(
            "/api/chatbot/",
            {"prompt": "genera la clase Gato"},
            format="json",
        )

        result = self.view(request)

        self.assertEqual(result.status_code, 504)

    @patch("uml_api.views.call_gemini", return_value="respuesta no JSON")
    def test_returns_502_for_invalid_model_output(self, _call_gemini):
        request = self.factory.post(
            "/api/chatbot/",
            {"prompt": "genera la clase Gato"},
            format="json",
        )

        result = self.view(request)

        self.assertEqual(result.status_code, 502)

    @patch("uml_api.views.call_gemini", return_value='{"classes": [], "relationships": []}')
    def test_passes_current_diagram_to_gemini(self, call_gemini_mock):
        current_diagram = {
            "classes": [{"id": "class-1", "name": "Cliente"}],
            "relationships": [],
        }
        request = self.factory.post(
            "/api/chatbot/",
            {
                "prompt": "elimina la clase Cliente",
                "currentDiagram": current_diagram,
                "source": "voice",
            },
            format="json",
        )

        result = self.view(request)

        self.assertEqual(result.status_code, 200)
        call_gemini_mock.assert_called_once_with(
            "elimina la clase Cliente",
            current_diagram,
        )
