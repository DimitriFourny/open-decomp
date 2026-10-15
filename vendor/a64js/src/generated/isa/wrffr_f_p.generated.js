export const ENCODINGS = [
    {
        "instructionId": "wrffr_f_p",
        "encodingId": "wrffr_f_p_",
        "mnemonic": "WRFFR",
        "className": "SVE",
        "fileName": "wrffr_f_p.xml",
        "mask": 4294966815,
        "value": 623415296,
        "bitCount": 28,
        "fields": [
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicate-control"
    }
];
